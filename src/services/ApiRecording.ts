import {App, Notice, TFile, TFolder, normalizePath} from "obsidian";
import {recordingHealth, recordingStart, recordingStop, recordingStatus, recordingSessionStatus} from "./RecordingApi";
import type {SessionGuidStatus} from "./RecordingApi";
import {batchUpdateFrontmatter} from "../utils/frontmatter";
import type {CardUiState, RecordingInfo} from "./CardUiState";
import {formatDate, formatTime, sleep} from "../utils/time";
import type {CalendarEvent} from "../types";
import {resolveWikiLink} from "../utils/vault";
import {parseDisplayName} from "../utils/nameParser";
import type {OnStatus} from "./LinkRecording";
import {FM} from "../constants";

/** Prevents duplicate waitAndLink calls when stopApiRecording and watchApiRecording
 *  race. Keyed by session guid (note path for legacy sessions without one) so a
 *  re-record's link tail is never swallowed by the prior session's still-running tail. */
const linkingInProgress = new Set<string>();

/**
 * Plugin-lifecycle stop signal for the fire-and-forget watch/link loops. The
 * recording watch loop stops via cardUi.clear() on unload, but waitAndLink's
 * transcribe-wait poll (up to ~5 min) would otherwise keep running — and
 * writing vault files — after the plugin is disabled.
 */
let watchersStopped = false;
export function stopApiRecordingWatchers(): void { watchersStopped = true; }
/** Re-arm after a plugin reload in case the module instance was reused. */
export function resetApiRecordingWatchers(): void { watchersStopped = false; }

/**
 * In-flight recording bookkeeping persisted to data.json so an Obsidian restart
 * mid-recording (or mid-transcription) can reconnect instead of orphaning the
 * session (SESSION_GUID_DESIGN.md §7). Written on start, removed on successful
 * link / terminal failure, reconciled on plugin load.
 */
export interface PersistedApiRecording {
	sessionGuid: string;
	/** Note path at record-start. Best-effort — reconciliation falls back to a
	 *  vault scan for the note carrying this session_guid when it was renamed. */
	notePath: string;
	transcriptFolderPath: string;
	suggestedFilename: string;
	startedAtIso: string;
	guidAcknowledged: boolean;
}

export interface ApiRecordingPersistence {
	add(entry: PersistedApiRecording): void;
	remove(sessionGuid: string): void;
}

/** Registered by the plugin on load (it owns data.json); null when unloaded.
 *  Same module-level pattern as watchersStopped. */
let persistence: ApiRecordingPersistence | null = null;
export function registerApiRecordingPersistence(p: ApiRecordingPersistence | null): void {
	persistence = p;
}

/**
 * Heuristic: did /start fail because the service is already capturing? The error
 * is the API's "Recording API error: <status> <body>" message; the service returns
 * a conflict (409) whose body explains it's already recording. Match either signal.
 */
function isAlreadyRecordingError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const m = err.message.toLowerCase();
	return m.includes("already recording") || m.includes("409");
}

function getTranscriptFilename(notePath: string): string {
	const basename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "Transcript";
	return `${basename} - Transcript`;
}

function getTranscriptPath(notePath: string, transcriptFolderPath: string): string {
	return normalizePath(`${transcriptFolderPath}/${getTranscriptFilename(notePath)}.md`);
}

export async function startApiRecording(opts: {
	app: App;
	notePath: string;
	event: CalendarEvent;
	transcriptFolderPath: string;
	timezone: string;
	baseUrl: string;
	cardUi: CardUiState;
}): Promise<void> {
	const {notePath, event, transcriptFolderPath, timezone, baseUrl, cardUi} = opts;

	const health = await recordingHealth(baseUrl);
	if (!health.modelsReady) {
		throw new Error("Recording service is still loading models…");
	}
	// No pre-block on the service's state here: whether a new recording can start
	// while another is active is the service's call, and the UI already consulted
	// /status and got the user's confirmation before reaching this point.

	const suggestedFilename = getTranscriptFilename(notePath);
	// Correlation guid for this session (SESSION_GUID_DESIGN.md): WhisperCal is
	// the initiator, so it owns identity. Sent to the service, stamped on the
	// note, and used from here on to match status and transcript by id instead
	// of by filename.
	const sessionGuid = crypto.randomUUID();

	let guidAcknowledged = false;
	try {
		const result = await recordingStart(baseUrl, suggestedFilename, {
			subject: event.subject,
			attendees: event.attendees.map(a => a.name || a.email),
		}, sessionGuid);
		guidAcknowledged = result.guidAcknowledged;
	} catch (err) {
		// The UI consults /status first, but that read can be stale (the service
		// began capturing in the gap). The service then rejects /start because it's
		// already recording — surface the same plain guidance as the pre-check
		// notice instead of leaking the raw "Recording API error: 409 …" string.
		if (isAlreadyRecordingError(err)) {
			throw new Error("The recording service is already recording. Stop that recording before starting a new one.");
		}
		throw err;
	}

	// Capture a live TFile reference so a rename during recording doesn't
	// orphan the linking step (TFile.path is auto-updated on rename).
	const resolved = opts.app.vault.getAbstractFileByPath(notePath);
	const noteFile = resolved instanceof TFile ? resolved : null;
	if (!noteFile) {
		console.warn(`[WhisperCal] startApiRecording: no TFile at "${notePath}" — linking will rely on path fallback`);
	}
	if (!guidAcknowledged) {
		console.debug(`[WhisperCal] Recording service did not echo sessionGuid — legacy filename-based linking for ${notePath}`);
	}

	// Stamp the note with the session guid. The note tracks the LATEST session,
	// so a re-record overwrites a prior value. Non-fatal: linking still works via
	// the in-memory/persisted state; the stamp is what enables rename-tolerant
	// recovery and unlinked-flow auto-matching.
	try {
		await batchUpdateFrontmatter(opts.app, notePath, {[FM.SESSION_GUID]: sessionGuid});
	} catch (err) {
		console.warn(`[WhisperCal] Failed to stamp ${FM.SESSION_GUID} on ${notePath}:`, err);
	}

	cardUi.setRecording(notePath, {
		noteFile,
		sessionGuid,
		guidAcknowledged,
		suggestedFilename,
		subject: event.subject,
		attendees: event.attendees.map(a => parseDisplayName(a.name, a.email)),
		isRecurring: event.isRecurring,
		timezone,
		transcriptFolderPath,
		meetingDate: formatDate(event.startTime, timezone),
		meetingStart: formatTime(event.startTime, timezone),
		meetingEnd: formatTime(event.endTime, timezone),
		organizer: event.organizerName,
		location: event.location,
	});
	persistence?.add({
		sessionGuid,
		notePath,
		transcriptFolderPath,
		suggestedFilename,
		startedAtIso: new Date().toISOString(),
		guidAcknowledged,
	});
	console.debug(`[WhisperCal] API recording started for ${notePath} (session ${sessionGuid})`);
}

export async function stopApiRecording(opts: {
	app: App;
	notePath: string;
	transcriptFolderPath: string;
	baseUrl: string;
	cardUi: CardUiState;
	onStatus?: OnStatus;
}): Promise<void> {
	const {app, notePath, transcriptFolderPath, baseUrl, cardUi, onStatus} = opts;

	const info = cardUi.getRecording(notePath) ?? null;
	// Delete state BEFORE the async API call so the watch loop's guard
	// exits immediately and doesn't race us to waitAndLink.
	cardUi.deleteRecording(notePath);
	// Identity check before the global /stop: if our capture ended app-side and a
	// NEW session started inside the watch loop's poll gap, the service's live
	// recording is no longer ours — a blind /stop would kill it. The /status
	// payload reports the live capture's sessionGuid for exactly this purpose.
	let skipStop = false;
	if (info?.sessionGuid) {
		try {
			const status = await recordingStatus(baseUrl);
			skipStop = status.state === "recording"
				&& !!status.sessionGuid
				&& status.sessionGuid !== info.sessionGuid;
		} catch {
			// Unreachable — the stop POST below tolerates that on its own.
		}
	}
	if (skipStop) {
		console.debug(`[WhisperCal] Skipping /stop for ${notePath} — the live capture belongs to another session`);
	} else {
		try {
			await recordingStop(baseUrl);
		} catch {
			// API may be unreachable — proceed to link any existing transcript
		}
	}
	console.debug(`[WhisperCal] API recording stopped for ${notePath}`);

	// Fire-and-forget: wait for transcription then link
	void waitAndLink(app, notePath, transcriptFolderPath, info, baseUrl, onStatus);
}

/**
 * Poll the recording API to detect when recording stops (e.g. stopped from the app's UI).
 * Calls `onStopped` when recording is no longer active, then triggers
 * the transcript linking flow.
 */
export function watchApiRecording(opts: {
	app: App;
	notePath: string;
	transcriptFolderPath: string;
	baseUrl: string;
	cardUi: CardUiState;
	onStopped: () => void;
	onStatus?: OnStatus;
}): void {
	const {app, notePath, transcriptFolderPath, baseUrl, cardUi, onStopped, onStatus} = opts;
	const WATCH_INTERVAL_MS = 2000;
	/** Consecutive /status failures tolerated before declaring the capture over.
	 *  One dropped 2 s poll is not evidence the service died. */
	const MAX_STATUS_FAILURES = 3;
	let statusFailures = 0;

	void (async () => {
		for (;;) {
			await sleep(WATCH_INTERVAL_MS);
			if (watchersStopped) return; // plugin unloaded
			if (!cardUi.hasRecording(notePath)) return; // stopped via WhisperCal
			try {
				// Per-guid status when the service acknowledged our guid: stays
				// unambiguous when a prior session is post-processing while this one
				// records. A 404 ("unknown") means the service restarted and lost the
				// session — treated like a failed poll so a blip doesn't end a live
				// recording, but repeated misses concede to the link tail.
				const rec = cardUi.getRecording(notePath);
				let state: string;
				let startedAt: number | undefined;
				if (rec?.guidAcknowledged) {
					const s = await recordingSessionStatus(baseUrl, rec.sessionGuid);
					if (s.state === "unknown") throw new Error("session unknown to recording service");
					state = s.state;
					startedAt = s.startedAt;
				} else {
					const s = await recordingStatus(baseUrl);
					state = s.state;
					startedAt = s.startedAt;
				}
				statusFailures = 0;
				// Re-check after async call — stopApiRecording may have
				// deleted the state while we were awaiting the status check.
				if (!cardUi.hasRecording(notePath)) return;
				// Release the recording lock the moment active capture ends.
				// "transcribing"/"complete"/"idle" mean the mic is free, so another
				// meeting can start recording while this one finishes post-processing;
				// waitAndLink owns the transcribe→link tail from here.
				if (state !== "recording") {
					const info = cardUi.getRecording(notePath) ?? null;
					cardUi.deleteRecording(notePath);
					console.debug(`[WhisperCal] API capture ended (state=${state}) for ${notePath}`);
					onStopped();
					void waitAndLink(app, notePath, transcriptFolderPath, info, baseUrl, onStatus);
					return;
				}
				// Still recording: anchor the elapsed timer to the service's reported
				// start time so WhisperCal's counter matches the recording app's instead
				// of drifting by the start-call latency. Same machine, so the epoch is
				// directly comparable. Only re-anchor on a meaningful gap to avoid churn
				// (and no-op entirely when the service doesn't report a start time).
				if (startedAt !== undefined) {
					const current = cardUi.getStartTime(notePath);
					if (current === undefined || Math.abs(current - startedAt) > 1500) {
						cardUi.setStartTime(notePath, startedAt);
					}
				}
			} catch (e) {
				// A single failed poll is usually a blip, not a dead service — giving up
				// on it would leave the finished transcript unlinked while the service
				// kept recording. Only concede after several consecutive failures, and
				// then still run the transcribe→link tail like the stop path does.
				if (++statusFailures < MAX_STATUS_FAILURES) {
					console.debug(`[WhisperCal] API status check failed (${statusFailures}/${MAX_STATUS_FAILURES}) for ${notePath}:`, e);
					continue;
				}
				const info = cardUi.getRecording(notePath) ?? null;
				cardUi.deleteRecording(notePath);
				console.debug(`[WhisperCal] API unreachable after ${statusFailures} attempts — treating ${notePath} as stopped`);
				onStopped();
				void waitAndLink(app, notePath, transcriptFolderPath, info, baseUrl, onStatus);
				return;
			}
		}
	})();
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 100; // ~5 minutes

/**
 * Find the newest transcript file in a folder created after a given timestamp.
 * Restricted to `.md` files whose basename starts with `namePrefix` (the
 * recording's suggestedFilename) so concurrent recordings can't cross-adopt each
 * other's transcripts, and so a sibling `.m4a`/`.voiceprints.json` that lands
 * before the `.md` is never mistaken for the transcript.
 */
function findNewestFile(app: App, folderPath: string, afterMs: number, namePrefix: string | undefined): TFile | null {
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return null;
	let newest: TFile | null = null;
	let newestTime = afterMs;
	for (const child of folder.children) {
		if (!(child instanceof TFile)) continue;
		if (child.extension !== "md") continue;
		if (namePrefix && !child.basename.startsWith(namePrefix)) continue;
		if (child.stat.ctime > newestTime) {
			newest = child;
			newestTime = child.stat.ctime;
		}
	}
	return newest;
}

/**
 * Read a transcript's session_guid, tolerating metadata-cache lag: the cache is
 * authoritative when it has indexed the file, but Tome writes transcripts outside
 * Obsidian, so a just-finished file may not be indexed yet — fall back to a raw
 * read of the frontmatter block. Returns undefined when absent/unreadable.
 */
async function readTranscriptSessionGuid(app: App, file: TFile): Promise<string | undefined> {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
	const cached = fm?.[FM.SESSION_GUID];
	if (typeof cached === "string" && cached) return cached;
	return readRawSessionGuid(app, file.path);
}

/** Raw-parse a scalar value out of a file's frontmatter block via the adapter
 *  (the file may not be in the vault index yet, and the metadata cache can lag
 *  well behind a file written outside Obsidian). `key` must be a plain
 *  frontmatter key with no regex metacharacters. */
async function readRawFrontmatterValue(app: App, path: string, key: string): Promise<string | undefined> {
	try {
		const content = await app.vault.adapter.read(path);
		if (!content.startsWith("---\n")) return undefined;
		const end = content.indexOf("\n---", 4);
		if (end < 0) return undefined;
		const block = content.slice(4, end);
		const m = block.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m"));
		return m?.[1];
	} catch {
		return undefined;
	}
}

async function readRawSessionGuid(app: App, path: string): Promise<string | undefined> {
	return readRawFrontmatterValue(app, path, FM.SESSION_GUID);
}

/**
 * Match-ladder rung 2 (SESSION_GUID_DESIGN.md §6): find the transcript stamped
 * with our guid. A guid equality is definitive — no time-window or name filter
 * needed. The raw-read fallback is bounded to recently-touched files so a large
 * archive folder isn't re-read on every miss.
 */
async function findTranscriptByGuid(app: App, folderPath: string, sessionGuid: string): Promise<TFile | null> {
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return null;
	const unindexed: TFile[] = [];
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		const cache = app.metadataCache.getFileCache(child);
		if (cache) {
			// Indexed: the cache is authoritative. Tome stamps the guid from the very
			// first write, so an indexed file without our guid is simply not ours.
			if (cache.frontmatter?.[FM.SESSION_GUID] === sessionGuid) return child;
			continue;
		}
		unindexed.push(child);
	}
	const cutoff = Date.now() - 24 * 3600 * 1000;
	for (const file of unindexed) {
		if (file.stat.ctime < cutoff && file.stat.mtime < cutoff) continue;
		if (await readRawSessionGuid(app, file.path) === sessionGuid) return file;
	}
	return null;
}

/**
 * Find the meeting note stamped with a session guid — used to survive a note
 * rename that happened while Obsidian was closed, and by the unlinked-recordings
 * auto-link. Skips the transcript folder (transcripts carry the same guid) and
 * anything that identifies as a transcript via a meeting_note backlink.
 */
export function findNoteBySessionGuid(app: App, sessionGuid: string, excludeFolderPath: string): TFile | null {
	const excludePrefix = excludeFolderPath ? `${normalizePath(excludeFolderPath)}/` : null;
	for (const file of app.vault.getMarkdownFiles()) {
		if (excludePrefix && file.path.startsWith(excludePrefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || fm[FM.SESSION_GUID] !== sessionGuid) continue;
		if (fm[FM.MEETING_NOTE]) continue; // that's a transcript, not the note
		return file;
	}
	return null;
}

/**
 * Add WhisperCal pipeline frontmatter to a transcript file.
 * Preserves any existing frontmatter the recording service has written.
 */
async function enrichTranscriptFrontmatter(
	app: App,
	transcriptFile: TFile,
	notePath: string,
	info: RecordingInfo | null,
): Promise<void> {
	const noteBasename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
	if (!noteBasename) {
		// Writing `[[]]` here would produce a broken backlink that's hard to
		// notice later; log and skip so the absence is explicit in the logs.
		console.error(`[WhisperCal] enrichTranscriptFrontmatter: empty noteBasename from "${notePath}" — meeting_note will NOT be set on ${transcriptFile.path}`);
	}

	// Read meeting note for wiki-link invitees (PeopleMatchService already ran there)
	const noteFile = app.vault.getAbstractFileByPath(notePath);
	const noteFm = (noteFile instanceof TFile)
		? app.metadataCache.getFileCache(noteFile)?.frontmatter
		: undefined;
	const wikiInvitees = Array.isArray(noteFm?.[FM.MEETING_INVITEES])
		? noteFm[FM.MEETING_INVITEES] as string[]
		: null;

	await app.fileManager.processFrontMatter(transcriptFile, (fm: Record<string, unknown>) => {
		// Add tags — preserve existing, ensure "transcript" is present
		const existing = Array.isArray(fm["tags"]) ? fm["tags"] as string[] : [];
		if (!existing.includes("transcript")) {
			fm["tags"] = [...existing, "transcript"];
		}

		if (noteBasename) fm[FM.MEETING_NOTE] = `[[${noteBasename}]]`;
		fm[FM.PIPELINE_STATE] = "titled";

		// Session guid: preserve the service's stamp when present (it is the
		// file's identity); write ours only when missing — that upgrades a
		// legacy-service transcript matched by filename heuristics so future
		// tooling can correlate it by id.
		if (info?.sessionGuid) {
			const stamped = fm[FM.SESSION_GUID];
			if (typeof stamped !== "string" || !stamped) {
				fm[FM.SESSION_GUID] = info.sessionGuid;
			} else if (stamped !== info.sessionGuid) {
				console.debug(`[WhisperCal] ${transcriptFile.path} carries ${FM.SESSION_GUID} ${stamped}, session expected ${info.sessionGuid} — keeping the file's value`);
			}
		}

		if (info) {
			fm["meeting_subject"] = info.subject;
			fm["is_recurring"] = info.isRecurring;
			// Prefer wiki-link invitees from meeting note, fall back to plain names
			if (wikiInvitees && wikiInvitees.length > 0) {
				fm[FM.MEETING_INVITEES] = wikiInvitees;
			} else if (info.attendees.length > 0) {
				fm[FM.MEETING_INVITEES] = info.attendees;
			}
			// Calendar event context — makes transcript self-contained for LLM use
			if (info.meetingDate) fm["meeting_date"] = info.meetingDate;
			if (info.meetingStart) fm["meeting_start"] = info.meetingStart;
			if (info.meetingEnd) fm["meeting_end"] = info.meetingEnd;
			if (info.organizer) fm["meeting_organizer"] = info.organizer;
			if (info.location) fm["meeting_location"] = info.location;
		}
	});
}

async function waitAndLink(app: App, notePath: string, transcriptFolderPath: string, info: RecordingInfo | null, baseUrl: string, onStatus?: OnStatus, sinceMs?: number): Promise<void> {
	// Guard: only one linking flow per session at a time.
	// stopApiRecording and watchApiRecording can race each other to this point.
	const guardKey = info?.sessionGuid ?? notePath;
	if (linkingInProgress.has(guardKey)) return;
	linkingInProgress.add(guardKey);

	// Anchor for rung 3's newest-file window. Reconcile passes the persisted
	// record-start time — a reconciled session's transcript was written while
	// Obsidian was closed, so it always predates this function's entry.
	const beforeStop = sinceMs ?? Date.now();
	const sessionGuid = info?.sessionGuid;
	const useGuid = !!sessionGuid && !!info?.guidAcknowledged;
	onStatus?.("Waiting for transcript…", undefined, undefined, undefined, "Waiting");
	try {
		// --- Wait for post-processing to finish ---
		// Per-guid when the service acknowledged our guid (unambiguous when a
		// prior session post-processes while a new one records), global /status
		// otherwise (legacy service). guidTranscriptFilename is the service-
		// reported FINAL basename — authoritative, immune to collision suffixes.
		let guidTranscriptFilename: string | undefined;
		if (useGuid && sessionGuid) {
			// The stall cap only counts polls that show no sign of progress. While
			// the service reports "transcribing" it is working normally — a long
			// meeting's on-device transcription can far exceed 5 minutes — so those
			// polls reset the counter, bounded by an absolute backstop.
			const TRANSCRIBE_BACKSTOP_MS = 2 * 3600 * 1000;
			const waitStart = Date.now();
			let stalledPolls = 0;
			for (;;) {
				await sleep(POLL_INTERVAL_MS);
				if (watchersStopped) return;
				let status: SessionGuidStatus;
				try {
					status = await recordingSessionStatus(baseUrl, sessionGuid);
				} catch {
					// Service may have shut down — the transcript may already be on
					// disk, so fall through to the guid scan / file check.
					break;
				}
				if (status.state === "complete") {
					guidTranscriptFilename = status.transcriptFilename;
					break;
				}
				if (status.state === "failed") {
					// Terminal: there is no transcript to find, so don't fall through
					// to filename scanning (it could adopt a foreign file).
					console.error(`[WhisperCal] Recording session ${sessionGuid} failed in the service: ${status.error ?? "no detail"}`);
					onStatus?.("Recording service failed to produce a transcript", "alert-circle", 8000, "warning", "Failed");
					persistence?.remove(sessionGuid);
					return;
				}
				// "unknown": the service restarted or evicted the session — the file
				// may still exist; break to the guid scan instead of polling a void.
				if (status.state === "unknown") break;
				if (status.state === "transcribing") {
					onStatus?.("Transcribing…", undefined, undefined, undefined, "Transcribing");
					stalledPolls = 0;
				} else {
					stalledPolls++;
				}
				if (stalledPolls >= MAX_POLL_ATTEMPTS || Date.now() - waitStart > TRANSCRIBE_BACKSTOP_MS) {
					onStatus?.("Transcript not ready — check recording service", "alert-circle", 6000, "warning", "Not ready");
					return;
				}
			}
		} else {
			// Poll recording API status until transcription completes
			for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
				await sleep(POLL_INTERVAL_MS);
				if (watchersStopped) return;
				try {
					const {state} = await recordingStatus(baseUrl);
					if (state === "complete") break;
					if (state === "transcribing") {
						onStatus?.("Transcribing…", undefined, undefined, undefined, "Transcribing");
					}
				} catch {
					// Service may have shut down — fall through to file check
					break;
				}
				if (i === MAX_POLL_ATTEMPTS - 1) {
					onStatus?.("Transcript not ready — check recording service", "alert-circle", 6000, "warning", "Not ready");
					return;
				}
			}
		}

		// --- Locate the transcript: match ladder (SESSION_GUID_DESIGN.md §6) ---
		// Rungs only fall downward; an id-based hit always beats heuristics.
		let transcriptFile: TFile | null = null;

		// Rung 1: exact filename reported by the per-guid status. Poll briefly —
		// the service writes outside Obsidian, so the vault index may lag.
		if (guidTranscriptFilename && sessionGuid) {
			const guidPath = normalizePath(`${transcriptFolderPath}/${guidTranscriptFilename}`);
			for (let i = 0; i < 15 && !transcriptFile; i++) {
				const byPath = app.vault.getAbstractFileByPath(guidPath);
				if (byPath instanceof TFile) {
					transcriptFile = byPath;
					break;
				}
				await sleep(1000);
				if (watchersStopped) return;
			}
			if (transcriptFile) {
				// Verify the file really carries our guid — a stale/foreign file at
				// this path must not be cross-wired. An unreadable/unstamped file is
				// still accepted: the service itself named this file for this guid.
				const fileGuid = await readTranscriptSessionGuid(app, transcriptFile);
				if (fileGuid !== undefined && fileGuid !== sessionGuid) {
					console.warn(`[WhisperCal] ${transcriptFile.path} carries ${FM.SESSION_GUID} ${fileGuid}, expected ${sessionGuid} — falling back to guid scan`);
					transcriptFile = null;
				}
			}
		}

		// Rung 2: scan the transcript folder for the file stamped with our guid.
		// Catches service-crash/orphan-refinalize cases (the guid is written at
		// session START) and completed sessions the service no longer remembers.
		if (!transcriptFile && useGuid && sessionGuid) {
			transcriptFile = await findTranscriptByGuid(app, transcriptFolderPath, sessionGuid);
		}

		// Rung 3 (legacy heuristics — the only path for an unacknowledged guid,
		// and the last resort otherwise). The recording service named the file
		// from the suggestedFilename captured at record-start — derive the
		// expected path from it directly; the caller's notePath may reflect a
		// rename made after recording began.
		if (!transcriptFile) {
			const namePrefix = info?.suggestedFilename;
			const expectedPath = namePrefix
				? normalizePath(`${transcriptFolderPath}/${namePrefix}.md`)
				: getTranscriptPath(notePath, transcriptFolderPath);

			// Poll ONLY the expected path for the full window. With concurrent
			// recordings, an immediate newest-file fallback could adopt another
			// meeting's transcript and then cross-wire its frontmatter — so we scan
			// the folder only once, after the window expires, and only for a file
			// whose basename matches this recording's suggestedFilename.
			for (let i = 0; i < 15 && !transcriptFile; i++) {
				await sleep(1000);
				if (watchersStopped) return;
				const byPath = app.vault.getAbstractFileByPath(expectedPath);
				if (byPath instanceof TFile) transcriptFile = byPath;
			}
			if (!transcriptFile) {
				transcriptFile = findNewestFile(app, transcriptFolderPath, beforeStop, namePrefix);
			}
		}

		if (!transcriptFile) {
			onStatus?.("Transcript file not found — check output folder", "alert-circle", 6000, "warning", "Not found");
			return;
		}

		// Resolve the meeting note's CURRENT path. Prefer the live TFile captured
		// at record-start — its .path is auto-updated by Obsidian on rename — and
		// fall back to the original notePath string for older recordings (or if
		// the TFile couldn't be resolved at start-time).
		const liveNoteFile = info?.noteFile ?? null;
		let noteFile: TFile | null = null;
		if (liveNoteFile && app.vault.getAbstractFileByPath(liveNoteFile.path) === liveNoteFile) {
			noteFile = liveNoteFile;
		} else {
			const fallback = app.vault.getAbstractFileByPath(notePath);
			if (fallback instanceof TFile) noteFile = fallback;
		}

		if (!noteFile) {
			console.error(`[WhisperCal] Cannot link transcript: meeting note missing (original path "${notePath}", live path "${liveNoteFile?.path ?? "n/a"}")`);
			onStatus?.("Meeting note missing — transcript not linked", "alert-circle", 6000, "warning", "Not linked");
			// The note is gone for good — retrying on the next reload can't succeed.
			// The transcript stays reachable via the unlinked-recordings flow.
			if (sessionGuid) persistence?.remove(sessionGuid);
			return;
		}
		const currentNotePath = noteFile.path;

		// The note tracks its LATEST session. If a re-record superseded this
		// session while its link tail was still in flight, don't overwrite the
		// newer session's transcript pointer — and don't enrich this transcript
		// either: a meeting_note backlink would hide it from the unlinked list,
		// which is exactly where the user should decide its fate.
		const noteGuid = (app.metadataCache.getFileCache(noteFile)?.frontmatter as Record<string, unknown> | undefined)?.[FM.SESSION_GUID];
		if (sessionGuid && typeof noteGuid === "string" && noteGuid && noteGuid !== sessionGuid) {
			console.debug(`[WhisperCal] Session ${sessionGuid} superseded by ${noteGuid} on ${currentNotePath} — leaving ${transcriptFile.path} for the unlinked flow`);
			onStatus?.("Superseded by a newer recording — see unlinked transcripts", "alert-circle", 6000, "warning", "Superseded");
			persistence?.remove(sessionGuid);
			return;
		}

		// Enrich transcript with WhisperCal pipeline frontmatter.
		// Non-fatal: if enrichment fails, still link the transcript to the meeting note.
		onStatus?.("Enriching transcript…", undefined, undefined, undefined, "Enriching");
		let enrichmentFailed = false;
		try {
			await enrichTranscriptFrontmatter(app, transcriptFile, currentNotePath, info);
		} catch (err) {
			enrichmentFailed = true;
			console.error(`[WhisperCal] Transcript enrichment failed for ${transcriptFile.path} (continuing to link):`, err);
		}

		// Link transcript to meeting note + set pipeline state.
		// Batch into a single processFrontMatter call to avoid a race with the
		// pipeline_state mirror handler that fires when the transcript is enriched.
		const transcriptBasename = transcriptFile.basename;
		await batchUpdateFrontmatter(app, currentNotePath, {
			[FM.TRANSCRIPT]: `[[${transcriptBasename}]]`,
			[FM.PIPELINE_STATE]: "titled",
		});
		// Linked — the in-flight bookkeeping entry has served its purpose.
		if (sessionGuid) persistence?.remove(sessionGuid);

		// Verify the enrichment actually wrote meeting_note. The metadata cache
		// can lag arbitrarily behind a file Tome wrote outside Obsidian, so read
		// the raw frontmatter off disk (authoritative) instead of trusting it.
		if (!enrichmentFailed) {
			const written = await readRawFrontmatterValue(app, transcriptFile.path, FM.MEETING_NOTE);
			if (!written) {
				enrichmentFailed = true;
				console.error(`[WhisperCal] Transcript ${transcriptFile.path} linked but missing meeting_note — enrichment silently dropped the write`);
			}
		}

		if (enrichmentFailed) {
			onStatus?.("Transcript linked — enrichment incomplete", "alert-circle", 6000, "warning", "Linked");
		} else {
			onStatus?.("Transcript linked", "check", 4000, "done", "Linked");
		}
	} catch (err) {
		console.error("[WhisperCal] Transcript linking failed:", err);
		onStatus?.("Failed to link transcript", "alert-circle", 6000, "warning", "Failed");
	} finally {
		linkingInProgress.delete(guardKey);
	}
}

/**
 * Run the transcribe-wait → link tail for a session whose in-memory recording
 * entry was pruned outside the watch loop (CalendarView's stale-lock
 * reconciler). The linkingInProgress guard dedupes against a live watch loop
 * or stop handler that got there first.
 */
export function runApiLinkTail(app: App, notePath: string, transcriptFolderPath: string, info: RecordingInfo | null, baseUrl: string): void {
	void waitAndLink(app, notePath, transcriptFolderPath, info, baseUrl, undefined);
}

/** Entries older than this are abandoned at reconcile time (the transcript, if
 *  any, remains reachable via the unlinked-recordings flow). */
const RECONCILE_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * Reconcile persisted in-flight recordings after a plugin (re)load
 * (SESSION_GUID_DESIGN.md §7): re-attach the watch loop to a still-live capture,
 * resume the link tail for a session that finished while Obsidian was closed,
 * and drop entries that can no longer be resolved. Sequential on purpose — the
 * list is tiny and ordering keeps the log readable.
 */
export async function reconcileApiRecordings(opts: {
	app: App;
	entries: PersistedApiRecording[];
	baseUrl: string;
	cardUi: CardUiState;
	timezone: string;
}): Promise<void> {
	for (const entry of opts.entries) {
		if (watchersStopped) return;
		try {
			await reconcileOne(opts.app, entry, opts.baseUrl, opts.cardUi, opts.timezone);
		} catch (err) {
			console.warn(`[WhisperCal] Reconcile failed for session ${entry.sessionGuid}:`, err);
		}
	}
}

async function reconcileOne(app: App, entry: PersistedApiRecording, baseUrl: string, cardUi: CardUiState, timezone: string): Promise<void> {
	const {sessionGuid} = entry;

	// Resolve the note: original path first, then a guid scan (the note may have
	// been renamed while Obsidian was closed — the guid stamp survives renames).
	const byPath = app.vault.getAbstractFileByPath(entry.notePath);
	let noteFile = byPath instanceof TFile ? byPath : null;
	if (!noteFile) noteFile = findNoteBySessionGuid(app, sessionGuid, entry.transcriptFolderPath);
	if (!noteFile) {
		console.warn(`[WhisperCal] Reconcile: meeting note for session ${sessionGuid} not found (was "${entry.notePath}") — dropping entry`);
		persistence?.remove(sessionGuid);
		return;
	}
	const notePath = noteFile.path;

	const startedAtMs = Date.parse(entry.startedAtIso);
	if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs > RECONCILE_MAX_AGE_MS) {
		persistence?.remove(sessionGuid);
		new Notice(`Gave up re-linking the recording for "${noteFile.basename}" (older than 24 h) — check unlinked transcripts`);
		return;
	}

	// Already linked (a prior pass or the unlinked flow beat us) — stale entry.
	const noteFm = app.metadataCache.getFileCache(noteFile)?.frontmatter;
	if (noteFm?.[FM.TRANSCRIPT]) {
		persistence?.remove(sessionGuid);
		return;
	}

	const info = rebuildRecordingInfo(entry, noteFile, timezone);

	if (!entry.guidAcknowledged) {
		// Legacy service: no per-guid lookup exists. If a capture is live, re-attach
		// the watch — we can't verify WHICH session it is, but the link tail's
		// filename-prefix guard still prevents cross-adoption. Otherwise run the
		// legacy link tail directly against whatever is on disk.
		let state = "idle";
		try {
			state = (await recordingStatus(baseUrl)).state;
		} catch { /* service unreachable — treat as idle, the link tail copes */ }
		if (state === "recording") {
			attachReconciledRecording(app, entry, notePath, info, cardUi, baseUrl);
		} else {
			void waitAndLink(app, notePath, entry.transcriptFolderPath, info, baseUrl, undefined, startedAtMs);
		}
		return;
	}

	let status: SessionGuidStatus;
	try {
		status = await recordingSessionStatus(baseUrl, sessionGuid);
	} catch {
		// Service not running. A transcript finished before the restart may still
		// be on disk — the link tail's guid scan finds it; otherwise the entry
		// stays for the next load (the service may just not have launched yet).
		void waitAndLink(app, notePath, entry.transcriptFolderPath, info, baseUrl, undefined, startedAtMs);
		return;
	}
	switch (status.state) {
		case "recording":
			if (status.startedAt !== undefined) cardUi.setStartTime(notePath, status.startedAt);
			attachReconciledRecording(app, entry, notePath, info, cardUi, baseUrl);
			break;
		case "failed":
			console.error(`[WhisperCal] Reconcile: session ${sessionGuid} failed in the service: ${status.error ?? "no detail"}`);
			new Notice(`Recording for "${noteFile.basename}" failed in the recording service`);
			persistence?.remove(sessionGuid);
			break;
		default:
			// transcribing | complete | unknown — the link tail handles all three
			// (per-guid poll, then the guid scan when the session is unknown).
			void waitAndLink(app, notePath, entry.transcriptFolderPath, info, baseUrl, undefined, startedAtMs);
	}
}

/** Minimal RecordingInfo for a reconciled session. Meeting-context fields are
 *  left blank — enrichment tolerates their absence and prefers the note's own
 *  frontmatter for invitees anyway. */
function rebuildRecordingInfo(entry: PersistedApiRecording, noteFile: TFile, timezone: string): RecordingInfo {
	return {
		noteFile,
		sessionGuid: entry.sessionGuid,
		guidAcknowledged: entry.guidAcknowledged,
		suggestedFilename: entry.suggestedFilename,
		subject: noteFile.basename,
		attendees: [],
		isRecurring: false,
		timezone,
		transcriptFolderPath: entry.transcriptFolderPath,
	};
}

function attachReconciledRecording(app: App, entry: PersistedApiRecording, notePath: string, info: RecordingInfo, cardUi: CardUiState, baseUrl: string): void {
	cardUi.setRecording(notePath, info);
	watchApiRecording({
		app,
		notePath,
		transcriptFolderPath: entry.transcriptFolderPath,
		baseUrl,
		cardUi,
		// No card callbacks exist yet at load time: the recordings-change listener
		// re-renders the pill, and the watch loop clears its own state on stop.
		onStopped: () => {
			cardUi.stopDurationTimer(notePath);
			cardUi.deleteStartTime(notePath);
			cardUi.deleteStatus(notePath);
		},
	});
	console.debug(`[WhisperCal] Reconciled live recording ${entry.sessionGuid} for ${notePath}`);
}

/** Check if a meeting note already has a transcript linked. */
export function hasLinkedTranscript(app: App, notePath: string): boolean {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return false;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return !!fm?.[FM.TRANSCRIPT];
}

/** Resolve and return the linked transcript TFile, if any. */
export function getLinkedTranscriptFile(app: App, notePath: string): TFile | null {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return null;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	return resolveWikiLink(app, fm, "transcript", notePath);
}
