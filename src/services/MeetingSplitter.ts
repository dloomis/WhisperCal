import type {App} from "obsidian";
import {TFile, normalizePath} from "obsidian";
import type {WhisperCalSettings} from "../settings";
import {FM, SPLIT_MARKER} from "../constants";
import {ensureFolder, resolveVoiceprintSidecar, resolveTranscriptAudio, stripWikiLink} from "../utils/vault";
import {readFmString} from "../utils/frontmatter";
import {findSpeakerLabels, transcriptStartOffset} from "../utils/transcript";
import {
	coerceFmDate,
	coerceFmTime,
	formatDate,
	formatElapsed,
	formatTimeForFrontmatter,
	formatTimeHHmm,
	parseDateTime,
	parseDurationSeconds,
} from "../utils/time";
import {sanitizeFilename} from "../utils/sanitize";
import type {FrontmatterSpeaker} from "./SpeakerTagParser";

/**
 * Split one recording that captured two back-to-back meetings into two meetings.
 * The exact inverse of MeetingMerger: where merge folds N notes + transcripts
 * into one, split takes a single transcript, cuts it at a user-placed marker,
 * and mints a second transcript + meeting note for the tail — leaving the vault
 * looking as though there had always been two meetings.
 *
 * The one thing the two halves keep sharing is the audio file: there is only one
 * recording, and the tail's timestamps stay absolute so they still index into it.
 * MeetingDeleter's shared-audio guard exists for exactly that reason.
 */

export interface SplitResult {
	newNotePath: string;
	newTranscriptPath: string;
}

/**
 * Everything the confirm modal needs to preview the split, and everything
 * splitMeeting needs to perform it. Computed from a FRESH read of the transcript
 * (the marker lives in the editor buffer the user just typed into, so a cached
 * read would miss it).
 */
export interface SplitPlan {
	/** Fresh transcript content, marker still in place. */
	content: string;
	/** Absolute offset of the first part-B speaker line (the snapped boundary). */
	boundaryOffset: number;
	/** Seconds into the recording at which part B begins. */
	offsetSeconds: number;
	/** True when offsetSeconds was prorated from character position, not read
	 *  from a `(NNNN.NNN)` timestamp on the boundary line. */
	offsetIsEstimated: boolean;
	/** Wall-clock start of the recording (transcript `created` + `time`). */
	transcriptStart: Date;
	/** Wall-clock instant the second meeting begins. */
	splitTime: Date;
	/** Recording length from the transcript's `duration` (0 when absent). */
	totalSeconds: number;
	partASeconds: number;
	partBSeconds: number;
	/** Speaker-line counts on each side of the boundary. */
	partALineCount: number;
	partBLineCount: number;
	transcriptFm: Record<string, unknown>;
	/** Subject the transcript is currently filed under — the default title stem. */
	subject: string;
}

/**
 * Wikilink to a vault path, written as `[[folder/Name|Name]]`.
 *
 * Same rationale as MeetingMerger's: a bare `[[Name]]` binds to whichever
 * same-named note Obsidian finds first, so split backlinks could point at an
 * unrelated note. Hand-built (not fileManager.generateMarkdownLink) because
 * every reader of these fields parses `[[…]]` via stripWikiLink.
 */
function wikiLinkToPath(path: string): string {
	const base = basenameNoExt(path);
	const linkTarget = path.endsWith(".md") ? path.slice(0, -3) : path;
	return `[[${linkTarget}|${base}]]`;
}

function basenameNoExt(path: string): string {
	const name = path.split("/").pop() ?? path;
	return name.replace(/\.md$/, "");
}

/** First free path for "{folder}/{basename}.md", suffixing " (1)", " (2)", ... */
function uniquePath(app: App, folder: string, basename: string): string {
	let candidate = normalizePath(`${folder}/${basename}.md`);
	let i = 1;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = normalizePath(`${folder}/${basename} (${i}).md`);
		i++;
	}
	return candidate;
}

/**
 * Drop every marker line from `text`, plus one blank line immediately after it
 * (placeSplitMarker inserts the pair, so removing both leaves the transcript
 * byte-identical to how it looked before the marker went in).
 */
export function removeSplitMarker(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() === SPLIT_MARKER) {
			if (lines[i + 1] !== undefined && lines[i + 1]!.trim() === "") i++;
			continue;
		}
		out.push(lines[i]!);
	}
	return out.join("\n");
}

/** True when the text carries at least one split marker. */
export function hasSplitMarker(text: string): boolean {
	return text.includes(SPLIT_MARKER);
}

/** Name of a frontmatter attendee entry — flat string or FrontmatterSpeaker object. */
function attendeeName(entry: unknown): string | null {
	if (typeof entry === "string") return entry;
	if (entry !== null && typeof entry === "object") {
		return (entry as FrontmatterSpeaker).name ?? null;
	}
	return null;
}

/**
 * Keep only the attendee entries whose label actually appears in one half's
 * body. Handles both shapes the pipeline writes: flat strings (fresh Tome
 * transcripts) and FrontmatterSpeaker objects (after tagging). Returns null when
 * the source value isn't an array, so the caller can leave the key untouched.
 */
function filterAttendees(raw: unknown, keep: Set<string>): unknown[] | null {
	if (!Array.isArray(raw)) return null;
	return (raw as unknown[]).filter((entry) => {
		const name = attendeeName(entry);
		return name !== null && keep.has(name);
	});
}

/**
 * The keys one half's voiceprint sidecar must keep.
 *
 * The Tome sidecar's `speakers` map is keyed by DIARIZER STUBS ("Speaker 1"…),
 * and tagging never rewrites those keys — it only renames the body labels and
 * parks the stub on the attendee's `original_name`. Pruning by body label alone
 * therefore matches nothing on a tagged transcript and writes `speakers: {}`,
 * silently killing acoustic matching and enrollment for the tail forever. So the
 * keep-set is the kept attendees' stubs, unioned with the body labels (untagged
 * transcripts, where label and key are the same string).
 */
function sidecarKeysFor(rawAttendees: unknown, keep: Set<string>): Set<string> {
	const keys = new Set(keep);
	if (!Array.isArray(rawAttendees)) return keys;
	for (const entry of rawAttendees as unknown[]) {
		if (entry === null || typeof entry !== "object") continue;
		const name = attendeeName(entry);
		if (name === null || !keep.has(name)) continue;
		const orig = (entry as FrontmatterSpeaker).original_name;
		if (typeof orig === "string" && orig) keys.add(orig);
	}
	return keys;
}

/**
 * Filter `confirmed_speakers` for one half. Entries are wikilinks (`[[Dan
 * Loomis]]`) holding the CANONICAL People-note name, while the body labels hold
 * the name as typed — so testing the raw entry against a set of bare labels is
 * never true and would empty the field on both halves. Compare through
 * stripWikiLink, case-insensitively, and prefer keep-over-drop: an entry that
 * matches no label in EITHER half (canonical name drifted from what was typed)
 * stays on both rather than being silently destroyed.
 */
function filterConfirmedSpeakers(raw: unknown, mine: Set<string>, other: Set<string>): unknown[] | null {
	if (!Array.isArray(raw)) return null;
	const lower = (s: Set<string>): Set<string> => new Set([...s].map(v => v.toLowerCase()));
	const mineLower = lower(mine);
	const otherLower = lower(other);
	return (raw as unknown[]).filter((entry) => {
		if (typeof entry !== "string") return true;
		const name = (stripWikiLink(entry).split("/").pop() ?? "").toLowerCase();
		if (mineLower.has(name)) return true;
		return !otherLower.has(name);
	});
}

/** Distinct speaker labels in a chunk of transcript text, in order of appearance. */
function labelsIn(text: string): Set<string> {
	return new Set(findSpeakerLabels(text).map(l => l.name));
}

/**
 * Resolve the wall-clock instant the recording started. Prefers the transcript's
 * own `created` + `time` (what Tome stamped), falls back to the parent note's
 * `meeting_date` + `meeting_start`, and finally to the transcript file's ctime.
 * Always parsed in the configured zone — system-local parsing shifts a traveling
 * user's split by the offset between the two zones.
 */
function resolveTranscriptStart(
	transcriptFile: TFile,
	transcriptFm: Record<string, unknown>,
	noteFm: Record<string, unknown>,
	timezone: string,
): Date {
	const tDate = coerceFmDate(transcriptFm["created"]);
	const tTime = coerceFmTime(transcriptFm["time"]);
	if (tDate && tTime) {
		const parsed = parseDateTime(tDate, tTime, timezone);
		if (parsed) return parsed;
	}
	const nDate = coerceFmDate(noteFm["meeting_date"]);
	const nTime = coerceFmTime(noteFm["meeting_start"]);
	if (nDate && nTime) {
		const parsed = parseDateTime(nDate, nTime, timezone);
		if (parsed) return parsed;
	}
	return new Date(transcriptFile.stat.ctime);
}

/**
 * Validate the marker and compute every derived value for the split. Throws a
 * user-facing message on any problem — callers surface it as a Notice and stay
 * in split mode so the marker can be moved.
 */
export async function planSplit(
	app: App,
	settings: WhisperCalSettings,
	transcriptFile: TFile,
	noteFile: TFile,
): Promise<SplitPlan> {
	// A merged transcript deliberately keeps each part's own clock, so the
	// boundary line's `(NNNN.NNN)` stamp is relative to whichever part it sits in
	// — not to the merged transcript's `created`. Everything downstream (split
	// instant, part B's date/filename, both halves' meeting_end, click-to-play
	// indexing) would be minted from the wrong moment. The ⋯ menu already hides
	// Split here; this is the backstop.
	const mergedFm = app.metadataCache.getFileCache(transcriptFile)?.frontmatter;
	if (mergedFm?.[FM.MERGED_FROM] !== undefined) {
		throw new Error("This transcript was merged from several meetings — its timestamps restart at each part, so it can't be split");
	}

	// Fresh read, not cachedRead: the marker was typed into the editor moments ago.
	const content = await app.vault.read(transcriptFile);

	const first = content.indexOf(SPLIT_MARKER);
	if (first === -1) {
		throw new Error("No split marker found — click \"Place marker\" on the line where the second meeting begins");
	}
	if (content.indexOf(SPLIT_MARKER, first + SPLIT_MARKER.length) !== -1) {
		throw new Error("More than one split marker found — leave only one");
	}

	const bodyStart = transcriptStartOffset(content);
	if (first < bodyStart) {
		throw new Error("The split marker is above the transcript text — move it down into the spoken lines");
	}

	const labels = findSpeakerLabels(content.slice(bodyStart))
		.map(l => ({name: l.name, pos: bodyStart + l.pos}));
	const before = labels.filter(l => l.pos < first);
	const after = labels.filter(l => l.pos > first);
	if (before.length === 0) {
		throw new Error("No speaker lines before the split marker — the first meeting would be empty");
	}
	if (after.length === 0) {
		throw new Error("No speaker lines after the split marker — the second meeting would be empty");
	}

	// Snap forward to the next speaker line: a cut in the middle of a spoken
	// paragraph would orphan its text under the previous meeting's last label.
	const boundaryOffset = after[0]!.pos;

	const transcriptFm = (app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {}) as Record<string, unknown>;
	const noteFm = (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {}) as Record<string, unknown>;
	const transcriptStart = resolveTranscriptStart(transcriptFile, transcriptFm, noteFm, settings.timezone);
	const totalSeconds = parseDurationSeconds(transcriptFm["duration"]);

	// Every Tome speaker line carries its offset into the recording:
	// "**Speaker 4** (2304.737)". That is the authoritative split time.
	const lineEnd = content.indexOf("\n", boundaryOffset);
	const boundaryLine = content.slice(boundaryOffset, lineEnd === -1 ? content.length : lineEnd);
	const stamp = boundaryLine.match(/\((\d+(?:\.\d+)?)\)/);
	let offsetSeconds: number;
	let offsetIsEstimated = false;
	if (stamp) {
		offsetSeconds = Number(stamp[1]);
	} else {
		// MacWhisper-style transcripts without per-line offsets: prorate by
		// character position through the body. Rough, but it beats refusing.
		offsetIsEstimated = true;
		const span = Math.max(1, content.length - bodyStart);
		offsetSeconds = totalSeconds * ((boundaryOffset - bodyStart) / span);
	}
	if (!isFinite(offsetSeconds) || offsetSeconds < 0) offsetSeconds = 0;
	if (totalSeconds > 0) offsetSeconds = Math.min(offsetSeconds, totalSeconds);

	const splitTime = new Date(transcriptStart.getTime() + offsetSeconds * 1000);
	const subject = readFmString(transcriptFm, "meeting_subject")
		?? readFmString(noteFm, "meeting_subject")
		?? noteFile.basename;

	return {
		content,
		boundaryOffset,
		offsetSeconds,
		offsetIsEstimated,
		transcriptStart,
		splitTime,
		totalSeconds,
		partASeconds: offsetSeconds,
		partBSeconds: Math.max(0, totalSeconds - offsetSeconds),
		partALineCount: before.length,
		partBLineCount: after.length,
		transcriptFm,
		subject,
	};
}

/**
 * Perform the split. Ordering is deliberately crash-safe: everything belonging
 * to the SECOND meeting is created first (transcript → sidecar → note), and only
 * once all of it exists is the original transcript truncated. An interruption
 * therefore leaves at worst a stray unlinked pair the user can delete — never a
 * transcript whose tail has been thrown away.
 *
 * Re-plans from a fresh read rather than trusting the caller's preview, so a
 * marker moved between the modal opening and OK being clicked is honored.
 * Throws on any vault failure — the caller shows a Notice.
 */
export async function splitMeeting(
	app: App,
	settings: WhisperCalSettings,
	transcriptFile: TFile,
	noteFile: TFile,
	newTitle: string,
): Promise<SplitResult> {
	const title = newTitle.trim();
	if (!title) throw new Error("Enter a name for the second meeting");

	const plan = await planSplit(app, settings, transcriptFile, noteFile);
	const {content, boundaryOffset, offsetSeconds, splitTime, totalSeconds} = plan;
	const tz = settings.timezone;

	const noteFm = (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {}) as Record<string, unknown>;
	const transcriptFm = plan.transcriptFm;

	// ---- Both halves' text. The marker itself never survives into either file. ----
	const partAText = removeSplitMarker(content.slice(0, boundaryOffset)).trimEnd() + "\n";
	const partBLines = removeSplitMarker(content.slice(boundaryOffset)).trimEnd() + "\n";

	const partALabels = labelsIn(partAText.slice(transcriptStartOffset(partAText)));
	const partBLabels = labelsIn(partBLines);
	const partBSidecarKeys = sidecarKeysFor(transcriptFm["attendees"], partBLabels);

	// ---- Names. The date prefix comes from the SPLIT instant, not the
	// original's `created`: findLocalNotes only surfaces a local card on the day
	// matching its basename prefix, so a recording that ran past midnight must
	// file its second half under the day it actually started. ----
	const splitDate = formatDate(splitTime, tz);
	const stem = `${splitDate} ${formatTimeHHmm(splitTime, tz)} - ${sanitizeFilename(title)}`;

	const noteFolder = normalizePath(settings.noteFolderPath);
	const transcriptFolder = normalizePath(settings.transcriptFolderPath);
	await ensureFolder(app, noteFolder);
	await ensureFolder(app, transcriptFolder);

	// Reserve the new note's path up front so the new transcript — created first
	// — can already carry a correct meeting_note backlink.
	const newNotePath = uniquePath(app, noteFolder, stem);
	const newTranscriptPath = uniquePath(app, transcriptFolder, `${stem} - Transcript`);
	const newTranscriptBasename = basenameNoExt(newTranscriptPath);

	const pipelineState = readFmString(transcriptFm, FM.PIPELINE_STATE)
		?? readFmString(noteFm, FM.PIPELINE_STATE);

	// Timestamps stay ABSOLUTE (offsets into the shared audio), so the speaker-tag
	// modal's click-to-play still lands on the right moment in the one recording.
	const partBBody = `# ${newTranscriptBasename}\n\n`
		+ (totalSeconds > 0
			? `**Duration:** ${formatElapsed(plan.partBSeconds)} | **Speakers:** ${partBLabels.size}\n\n---\n\n`
			: "")
		+ `## Transcript\n${partBLines}`;

	// ---- 1. The second half's transcript ----
	const newTranscript = await app.vault.create(newTranscriptPath, partBBody);

	// Track what to unwind if a later step fails.
	const created: TFile[] = [newTranscript];
	const rollback = async (): Promise<void> => {
		for (const f of created.reverse()) {
			try {
				await app.fileManager.trashFile(f);
			} catch (cleanupErr) {
				console.error(`[WhisperCal] Failed to clean up ${f.path} after a failed split:`, cleanupErr);
			}
		}
	};

	try {
		// ---- 2. The voiceprint sidecar, pruned to the labels that actually speak
		// in the second half. Silently skipped when the recording had none. ----
		let newSidecarName: string | null = null;
		const sidecar = resolveVoiceprintSidecar(app, transcriptFile, transcriptFm);
		if (sidecar) {
			try {
				const parsed = JSON.parse(await app.vault.read(sidecar)) as Record<string, unknown>;
				const speakers = parsed["speakers"];
				if (speakers !== null && typeof speakers === "object") {
					const pruned: Record<string, unknown> = {};
					for (const [label, value] of Object.entries(speakers as Record<string, unknown>)) {
						if (partBSidecarKeys.has(label)) pruned[label] = value;
					}
					parsed["speakers"] = pruned;
				}
				// The GUID identifies the ORIGINAL capture session; leaving a copy on
				// the tail's sidecar would make two artifacts answer to one session.
				delete parsed["sessionGuid"];
				const sidecarPath = newTranscriptPath.replace(/\.md$/, ".voiceprints.json");
				created.push(await app.vault.create(sidecarPath, JSON.stringify(parsed, null, 2)));
				newSidecarName = sidecarPath.split("/").pop() ?? null;
			} catch (e) {
				// A malformed sidecar must not sink the split — the tail just won't
				// have acoustic matching until it's re-enrolled.
				console.warn(`[WhisperCal] Could not copy voiceprint sidecar for ${transcriptFile.path}:`, e);
			}
		}

		// ---- 3. The second half's transcript frontmatter ----
		const recording = readFmString(transcriptFm, "recording")
			?? (() => {
				const audio = resolveTranscriptAudio(app, transcriptFile, transcriptFm);
				return audio ? `[[${audio.name}]]` : undefined;
			})();

		await app.fileManager.processFrontMatter(newTranscript, (fm: Record<string, unknown>) => {
			for (const key of ["type", "source_app", "source_file", "context"]) {
				if (transcriptFm[key] !== undefined) fm[key] = transcriptFm[key];
			}
			fm["created"] = splitDate;
			fm["time"] = formatTimeForFrontmatter(splitTime, tz);
			if (totalSeconds > 0) fm["duration"] = formatElapsed(plan.partBSeconds);
			// Same audio: there is one recording behind both meetings.
			if (recording) fm["recording"] = recording;
			if (newSidecarName) fm[FM.VOICEPRINTS] = newSidecarName;
			// session_guid is deliberately NOT copied — it stays unique to part A so
			// Tome affinity lookups can never resolve one session to two transcripts.
			const attendees = filterAttendees(transcriptFm["attendees"], partBLabels);
			if (attendees) fm["attendees"] = attendees;
			const confirmed = filterConfirmedSpeakers(transcriptFm[FM.CONFIRMED_SPEAKERS], partBLabels, partALabels);
			if (confirmed) fm[FM.CONFIRMED_SPEAKERS] = confirmed;
			if (Array.isArray(transcriptFm["tags"])) fm["tags"] = [...(transcriptFm["tags"] as unknown[])];
			fm[FM.MEETING_NOTE] = wikiLinkToPath(newNotePath);
			fm["meeting_subject"] = title;
			fm["is_recurring"] = false;
			if (Array.isArray(noteFm[FM.MEETING_INVITEES])) {
				fm[FM.MEETING_INVITEES] = [...(noteFm[FM.MEETING_INVITEES] as unknown[])];
			}
			if (pipelineState) fm[FM.PIPELINE_STATE] = pipelineState;
			fm[FM.SPLIT_FROM] = wikiLinkToPath(transcriptFile.path);
			fm[FM.SPLIT_OFFSET] = Math.round(offsetSeconds * 1000) / 1000;
		});

		// ---- 4. The second half's meeting note ----
		const sourceLines = [
			`**Split from:** ${wikiLinkToPath(noteFile.path)}`,
			`**First half's transcript:** ${wikiLinkToPath(transcriptFile.path)}`,
			`**This meeting's transcript:** ${wikiLinkToPath(newTranscriptPath)}`,
		];
		const newNote = await app.vault.create(
			newNotePath,
			`# ${title}\n\n## Sources\n\n${sourceLines.join("\n")}\n`,
		);
		created.push(newNote);

		const recordingEnd = new Date(plan.transcriptStart.getTime() + Math.max(totalSeconds, offsetSeconds) * 1000);
		await app.fileManager.processFrontMatter(newNote, (fm: Record<string, unknown>) => {
			fm["meeting_subject"] = title;
			fm["meeting_date"] = splitDate;
			fm["meeting_start"] = formatTimeForFrontmatter(splitTime, tz);
			fm["meeting_end"] = formatTimeForFrontmatter(recordingEnd, tz);
			const loc = readFmString(noteFm, "meeting_location");
			if (loc) fm["meeting_location"] = loc;
			const org = readFmString(noteFm, "meeting_organizer");
			if (org) fm["meeting_organizer"] = org;
			if (Array.isArray(noteFm[FM.MEETING_INVITEES])) {
				fm[FM.MEETING_INVITEES] = [...(noteFm[FM.MEETING_INVITEES] as unknown[])];
			}
			fm["tags"] = ["meeting"];
			// Synthetic id, mirroring MeetingMerger's `merged-` convention: the note
			// has no Graph event of its own, so it surfaces as its own local card.
			fm[FM.CALENDAR_EVENT_ID] = `split-${basenameNoExt(newNotePath)}`;
			fm["calendar_provider"] = readFmString(noteFm, "calendar_provider") ?? settings.calendarProvider;
			fm["is_recurring"] = false;
			fm[FM.TRANSCRIPT] = wikiLinkToPath(newTranscriptPath);
			if (pipelineState) fm[FM.PIPELINE_STATE] = pipelineState;
			fm[FM.SPLIT_FROM] = wikiLinkToPath(noteFile.path);
		});
	} catch (err) {
		// Everything above belongs to a meeting that now doesn't exist — unwind it
		// so a retry doesn't mint "(1)" copies and the unlinked list stays clean.
		await rollback();
		throw err;
	}

	// ---- 5. Only now is the original touched. Body first, then frontmatter. ----
	await app.vault.process(transcriptFile, () => partAText);
	await app.fileManager.processFrontMatter(transcriptFile, (fm: Record<string, unknown>) => {
		if (offsetSeconds > 0) fm["duration"] = formatElapsed(plan.partASeconds);
		const attendees = filterAttendees(fm["attendees"], partALabels);
		if (attendees) fm["attendees"] = attendees;
		const confirmed = filterConfirmedSpeakers(fm[FM.CONFIRMED_SPEAKERS], partALabels, partBLabels);
		if (confirmed) fm[FM.CONFIRMED_SPEAKERS] = confirmed;
		fm[FM.SPLIT_INTO] = wikiLinkToPath(newTranscriptPath);
	});

	// ---- 6. The original meeting now ends where the second one begins. ----
	await app.fileManager.processFrontMatter(noteFile, (fm: Record<string, unknown>) => {
		fm["meeting_end"] = formatTimeForFrontmatter(splitTime, tz);
		fm[FM.SPLIT_INTO] = wikiLinkToPath(newNotePath);
	});

	return {newNotePath, newTranscriptPath};
}
