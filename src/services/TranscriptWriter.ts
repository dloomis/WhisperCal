import type {App} from "obsidian";
import {TFile, normalizePath} from "obsidian";
import {getTranscript} from "./MacWhisperDb";
import type {TranscriptData} from "./MacWhisperDb";
import {updateFrontmatter, batchUpdateFrontmatter} from "../utils/frontmatter";
import {ensureFolder} from "../utils/vault";
import {yamlEscape} from "../utils/sanitize";
import {coerceFmDate, coerceFmTime, formatDateTimeWithOffset} from "../utils/time";

interface SpeakerBlock {
	speaker: string | null;
	startMs: number;
	lines: string[];
}

function getTranscriptPath(notePath: string, transcriptFolderPath: string): string {
	// Extract basename without extension from the meeting note path
	const basename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "Transcript";
	return normalizePath(`${transcriptFolderPath}/${basename} - Transcript.md`);
}

function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTimestamp(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	return formatDuration(totalSec);
}

function groupBySpeaker(lines: TranscriptData["lines"]): SpeakerBlock[] {
	const blocks: SpeakerBlock[] = [];
	for (const line of lines) {
		const last = blocks[blocks.length - 1];
		if (last && last.speaker === line.speaker) {
			last.lines.push(line.text);
		} else {
			blocks.push({
				speaker: line.speaker,
				startMs: line.startMs,
				lines: [line.text],
			});
		}
	}
	return blocks;
}

function buildFrontmatter(opts: {
	notePath: string;
	sessionId: string;
	metadata: NonNullable<TranscriptData["metadata"]>;
	speakers: TranscriptData["speakers"];
	recordingStart: Date;
	timezone: string;
	calendarEvent: string;
	calendarAttendees: string[];
	isRecurring: boolean;
	/** Wiki-link formatted invitees from meeting note (overrides calendarAttendees). */
	wikiInvitees?: string[];
	/** Calendar context from meeting note — written to transcript for LLM use. */
	meetingDate?: string;
	meetingStart?: string;
	meetingEnd?: string;
	organizer?: string;
	location?: string;
}): string {
	const {notePath, sessionId, metadata, speakers, recordingStart, timezone, calendarEvent, calendarAttendees, isRecurring} = opts;

	const noteBasename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
	if (!noteBasename) {
		// Writing `[[]]` produces a broken backlink the user won't notice until
		// the speaker/summary stage fails; make the absence explicit.
		console.error(`[WhisperCal] TranscriptWriter.buildFrontmatter: empty noteBasename from "${notePath}" — meeting_note will NOT be written`);
	}
	const dateStr = formatDateTimeWithOffset(recordingStart, timezone);
	const duration = metadata.durationSec ? Math.round(metadata.durationSec) : 0;

	const lines = [
		"---",
		`date: ${dateStr}`,
		"tags: [transcript]",
		`macwhisper_session_id: "${yamlEscape(sessionId)}"`,
		`duration: ${duration}`,
	];
	if (noteBasename) {
		lines.push(`meeting_note: "[[${yamlEscape(noteBasename)}]]"`);
	}
	lines.push(`speaker_count: ${speakers.length}`);

	if (speakers.length > 0) {
		lines.push("speakers:");
		for (const sp of speakers) {
			lines.push(`  - name: "${yamlEscape(sp.name)}"`);
			lines.push(`    id: "${yamlEscape(sp.id)}"`);
			lines.push(`    stub: ${sp.isStub}`);
			lines.push(`    line_count: ${sp.lineCount}`);
		}
	}

	lines.push(`meeting_subject: "${yamlEscape(calendarEvent)}"`);
	lines.push(`is_recurring: ${isRecurring}`);
	// Prefer wiki-link invitees from meeting note (consistent with confirmed_speakers)
	const invitees = opts.wikiInvitees ?? calendarAttendees;
	if (invitees.length > 0) {
		lines.push("meeting_invitees:");
		for (const name of invitees) {
			lines.push(`  - "${yamlEscape(name)}"`);
		}
	}
	// Calendar context from meeting note — makes transcript self-contained for LLM use
	if (opts.meetingDate) lines.push(`meeting_date: "${yamlEscape(opts.meetingDate)}"`);
	if (opts.meetingStart) lines.push(`meeting_start: "${yamlEscape(opts.meetingStart)}"`);
	if (opts.meetingEnd) lines.push(`meeting_end: "${yamlEscape(opts.meetingEnd)}"`);
	if (opts.organizer) lines.push(`meeting_organizer: "${yamlEscape(opts.organizer)}"`);
	if (opts.location) lines.push(`meeting_location: "${yamlEscape(opts.location)}"`);
	// If all speakers are non-stub (real names, not generic "Speaker N"),
	// the session was independently tagged — skip to "tagged" state.
	const allSpeakersNamed = speakers.length > 0 && speakers.every(sp => !sp.isStub);
	lines.push(`pipeline_state: ${allSpeakersNamed ? "tagged" : "titled"}`);
	lines.push("---");

	return lines.join("\n");
}

function buildTranscriptBody(data: TranscriptData): string {
	const sections: string[] = [];

	sections.push("# Transcript");

	// AI Summary section (only if available)
	if (data.metadata?.aiSummary) {
		sections.push("");
		sections.push("## AI Summary");
		sections.push("");
		const quotedLines = data.metadata.aiSummary
			.split("\n")
			.map(line => `> ${line}`)
			.join("\n");
		sections.push(quotedLines);
	}

	sections.push("");
	sections.push("## Full Transcript");
	sections.push("");

	if (data.lines.length === 0) {
		sections.push("*No transcript lines available.*");
		return sections.join("\n");
	}

	const isDiarized = data.metadata?.hasBeenDiarized === 1;

	if (isDiarized) {
		const blocks = groupBySpeaker(data.lines);
		for (const block of blocks) {
			const timestamp = formatTimestamp(block.startMs);
			if (block.speaker) {
				sections.push(`**${block.speaker}** [${timestamp}]`);
			} else {
				sections.push(`[${timestamp}]`);
			}
			sections.push(block.lines.join(" "));
			sections.push("");
		}
	} else {
		// Not diarized — just timestamped lines
		for (const line of data.lines) {
			const timestamp = formatTimestamp(line.startMs);
			sections.push(`[${timestamp}] ${line.text}`);
		}
		sections.push("");
	}

	return sections.join("\n");
}

/**
 * Create a transcript markdown file from a MacWhisper session.
 * Returns the transcript file path on success, null if skipped.
 */
export async function createTranscriptFile(opts: {
	app: App;
	notePath: string;
	sessionId: string;
	transcriptFolderPath: string;
	recordingStart: Date;
	timezone: string;
	calendarEvent: string;
	calendarAttendees: string[];
	isRecurring: boolean;
}): Promise<string | null> {
	const {app, notePath, sessionId, transcriptFolderPath, recordingStart, timezone, calendarEvent, calendarAttendees, isRecurring} = opts;

	const transcriptPath = getTranscriptPath(notePath, transcriptFolderPath);

	// If transcript file already exists, ensure backlinks are set and return
	const existingTranscript = app.vault.getAbstractFileByPath(transcriptPath);
	if (existingTranscript instanceof TFile) {
		const transcriptBasename = transcriptPath.split("/").pop()?.replace(/\.md$/, "") ?? "";
		const noteBasename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "";

		// Heal an existing transcript that's missing the backlink. Previously
		// we silently skipped this, which left transcripts orphaned in the
		// meeting_note → note direction even though the note → transcript
		// link got written.
		const existingFm = app.metadataCache.getFileCache(existingTranscript)?.frontmatter;
		if (!existingFm?.["meeting_note"]) {
			if (!noteBasename) {
				console.error(`[WhisperCal] Cannot repair missing meeting_note on ${transcriptPath}: empty noteBasename from "${notePath}"`);
			} else {
				console.error(`[WhisperCal] Existing transcript missing meeting_note — repairing: ${transcriptPath}`);
				await app.fileManager.processFrontMatter(existingTranscript, (fm: Record<string, unknown>) => {
					fm["meeting_note"] = `[[${noteBasename}]]`;
				});
			}
		}

		await updateFrontmatter(app, notePath, "transcript", `[[${transcriptBasename}]]`);
		return transcriptPath;
	}

	const data = await getTranscript(sessionId);

	// Skip if session not found
	if (!data.metadata) return null;

	await ensureFolder(app, transcriptFolderPath);

	// Read meeting note frontmatter for wiki-link invitees + calendar context
	const noteFile = app.vault.getAbstractFileByPath(notePath);
	const noteFm = (noteFile instanceof TFile)
		? app.metadataCache.getFileCache(noteFile)?.frontmatter
		: undefined;
	const wikiInvitees = Array.isArray(noteFm?.["meeting_invitees"])
		? noteFm["meeting_invitees"] as string[]
		: undefined;

	const frontmatter = buildFrontmatter({
		notePath,
		sessionId,
		metadata: data.metadata,
		speakers: data.speakers,
		recordingStart,
		timezone,
		calendarEvent,
		calendarAttendees,
		isRecurring,
		wikiInvitees,
		meetingDate: coerceFmDate(noteFm?.["meeting_date"]),
		meetingStart: coerceFmTime(noteFm?.["meeting_start"]),
		meetingEnd: coerceFmTime(noteFm?.["meeting_end"]),
		organizer: noteFm?.["meeting_organizer"] as string | undefined,
		location: noteFm?.["meeting_location"] as string | undefined,
	});

	const body = buildTranscriptBody(data);
	const content = `${frontmatter}\n\n${body}`;

	await app.vault.create(transcriptPath, content);

	// Update meeting note frontmatter with link to transcript and pipeline state.
	// Batch into a single processFrontMatter call to avoid a race with the
	// pipeline_state mirror handler that fires when the transcript file is created.
	const transcriptBasename = transcriptPath.split("/").pop()?.replace(/\.md$/, "") ?? "";
	const allSpeakersNamed = data.speakers.length > 0 && data.speakers.every(sp => !sp.isStub);
	await batchUpdateFrontmatter(app, notePath, {
		transcript: `[[${transcriptBasename}]]`,
		pipeline_state: allSpeakersNamed ? "tagged" : "titled",
	});

	return transcriptPath;
}
