import {App, TFile, TFolder, normalizePath} from "obsidian";
import {recordingHealth, recordingStart, recordingStop, recordingStatus} from "./RecordingApi";
import {batchUpdateFrontmatter} from "../utils/frontmatter";
import type {CardUiState, RecordingInfo} from "./CardUiState";
import {formatDate, formatTime, sleep} from "../utils/time";
import type {CalendarEvent} from "../types";
import {resolveWikiLink} from "../utils/vault";
import {parseDisplayName} from "../utils/nameParser";
import type {OnStatus} from "./LinkRecording";
import {FM} from "../constants";

/** Prevents duplicate waitAndLink calls when stopApiRecording and watchApiRecording race. */
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
		throw new Error("Recording service is still loading models\u2026");
	}
	// No pre-block on the service's state here: whether a new recording can start
	// while another is active is the service's call, and the UI already consulted
	// /status and got the user's confirmation before reaching this point.

	const suggestedFilename = getTranscriptFilename(notePath);

	try {
		await recordingStart(baseUrl, suggestedFilename, {
			subject: event.subject,
			attendees: event.attendees.map(a => a.name || a.email),
		});
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

	cardUi.setRecording(notePath, {
		noteFile,
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
	console.debug(`[WhisperCal] API recording started for ${notePath}`);
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
	try {
		await recordingStop(baseUrl);
	} catch {
		// API may be unreachable — proceed to link any existing transcript
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

	void (async () => {
		for (;;) {
			await sleep(WATCH_INTERVAL_MS);
			if (watchersStopped) return; // plugin unloaded
			if (!cardUi.hasRecording(notePath)) return; // stopped via WhisperCal
			try {
				const {state, startedAt} = await recordingStatus(baseUrl);
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
			} catch {
				// API unreachable — treat as stopped
				cardUi.deleteRecording(notePath);
				onStopped();
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

async function waitAndLink(app: App, notePath: string, transcriptFolderPath: string, info: RecordingInfo | null, baseUrl: string, onStatus?: OnStatus): Promise<void> {
	// Guard: only one linking flow per note at a time.
	// stopApiRecording and watchApiRecording can race each other to this point.
	if (linkingInProgress.has(notePath)) return;
	linkingInProgress.add(notePath);

	const beforeStop = Date.now();
	onStatus?.("Waiting for transcript\u2026", undefined, undefined, undefined, "Waiting");
	try {
		// Poll recording API status until transcription completes
		for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
			await sleep(POLL_INTERVAL_MS);
			if (watchersStopped) return;
			try {
				const {state} = await recordingStatus(baseUrl);
				if (state === "complete") break;
				if (state === "transcribing") {
					onStatus?.("Transcribing\u2026", undefined, undefined, undefined, "Transcribing");
				}
			} catch {
				// Service may have shut down — fall through to file check
				break;
			}
			if (i === MAX_POLL_ATTEMPTS - 1) {
				onStatus?.("Transcript not ready \u2014 check recording service", "alert-circle", 6000, "warning", "Not ready");
				return;
			}
		}

		// Look for the transcript file in the vault. The recording service named
		// it from the suggestedFilename captured at record-start, so the expected
		// path derives from the ORIGINAL notePath even if the note was renamed.
		const expectedPath = getTranscriptPath(notePath, transcriptFolderPath);
		const namePrefix = info?.suggestedFilename;
		let transcriptFile: TFile | null = null;

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

		if (!transcriptFile) {
			onStatus?.("Transcript file not found \u2014 check output folder", "alert-circle", 6000, "warning", "Not found");
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
			onStatus?.("Meeting note missing \u2014 transcript not linked", "alert-circle", 6000, "warning", "Not linked");
			return;
		}
		const currentNotePath = noteFile.path;

		// Enrich transcript with WhisperCal pipeline frontmatter.
		// Non-fatal: if enrichment fails, still link the transcript to the meeting note.
		onStatus?.("Enriching transcript\u2026", undefined, undefined, undefined, "Enriching");
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

		// Verify the enrichment actually wrote meeting_note. metadataCache is
		// eventually consistent, so give it a moment; if still missing, warn loudly.
		if (!enrichmentFailed) {
			await sleep(500);
			const transcriptFm = app.metadataCache.getFileCache(transcriptFile)?.frontmatter;
			if (!transcriptFm?.[FM.MEETING_NOTE]) {
				enrichmentFailed = true;
				console.error(`[WhisperCal] Transcript ${transcriptFile.path} linked but missing meeting_note — enrichment silently dropped the write`);
			}
		}

		if (enrichmentFailed) {
			onStatus?.("Transcript linked \u2014 enrichment incomplete", "alert-circle", 6000, "warning", "Linked");
		} else {
			onStatus?.("Transcript linked", "check", 4000, "done", "Linked");
		}
	} catch (err) {
		console.error("[WhisperCal] Transcript linking failed:", err);
		onStatus?.("Failed to link transcript", "alert-circle", 6000, "warning", "Failed");
	} finally {
		linkingInProgress.delete(notePath);
	}
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
