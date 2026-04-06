import {App, TFile, TFolder, normalizePath} from "obsidian";
import {recordingHealth, recordingStart, recordingStop, recordingStatus} from "./RecordingApi";
import {batchUpdateFrontmatter} from "../utils/frontmatter";
import {recordingState, type RecordingInfo} from "../state";
import {formatDate, formatTime, sleep} from "../utils/time";
import type {CalendarEvent} from "../types";
import {resolveWikiLink} from "../utils/vault";
import {parseDisplayName} from "../utils/nameParser";
import type {OnStatus} from "./LinkRecording";

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
}): Promise<void> {
	const {notePath, event, transcriptFolderPath, timezone, baseUrl} = opts;

	const health = await recordingHealth(baseUrl);
	if (!health.modelsReady) {
		throw new Error("Recording service is still loading models\u2026");
	}
	if (health.isRecording) {
		throw new Error("Recording service is already recording");
	}

	const suggestedFilename = getTranscriptFilename(notePath);

	await recordingStart(baseUrl, suggestedFilename, {
		subject: event.subject,
		attendees: event.attendees.map(a => a.name || a.email),
	});

	recordingState.set(notePath, {
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
	onStatus?: OnStatus;
}): Promise<void> {
	const {app, notePath, transcriptFolderPath, baseUrl, onStatus} = opts;

	const info = recordingState.get(notePath) ?? null;
	// Delete state BEFORE the async API call so the watch loop's guard
	// (recordingState.has) exits immediately and doesn't race us to waitAndLink.
	recordingState.delete(notePath);
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
	onStopped: () => void;
	onStatus?: OnStatus;
}): void {
	const {app, notePath, transcriptFolderPath, baseUrl, onStopped, onStatus} = opts;
	const WATCH_INTERVAL_MS = 2000;

	void (async () => {
		for (;;) {
			await sleep(WATCH_INTERVAL_MS);
			if (!recordingState.has(notePath)) return; // stopped via WhisperCal
			try {
				const health = await recordingHealth(baseUrl);
				if (!health.isRecording) {
					const info = recordingState.get(notePath) ?? null;
					recordingState.delete(notePath);
					console.debug(`[WhisperCal] API recording stopped externally for ${notePath}`);
					onStopped();
					void waitAndLink(app, notePath, transcriptFolderPath, info, baseUrl, onStatus);
					return;
				}
			} catch {
				// API unreachable — treat as stopped
				recordingState.delete(notePath);
				onStopped();
				return;
			}
		}
	})();
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 100; // ~5 minutes

/** Find the newest file in a folder created after a given timestamp. */
function findNewestFile(app: App, folderPath: string, afterMs: number): TFile | null {
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return null;
	let newest: TFile | null = null;
	let newestTime = afterMs;
	for (const child of folder.children) {
		if (child instanceof TFile && child.stat.ctime > newestTime) {
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

	// Read meeting note for wiki-link invitees (PeopleMatchService already ran there)
	const noteFile = app.vault.getAbstractFileByPath(notePath);
	const noteFm = (noteFile instanceof TFile)
		? app.metadataCache.getFileCache(noteFile)?.frontmatter
		: undefined;
	const wikiInvitees = Array.isArray(noteFm?.["meeting_invitees"])
		? noteFm["meeting_invitees"] as string[]
		: null;

	await app.fileManager.processFrontMatter(transcriptFile, (fm: Record<string, unknown>) => {
		// Add tags — preserve existing, ensure "transcript" is present
		const existing = Array.isArray(fm["tags"]) ? fm["tags"] as string[] : [];
		if (!existing.includes("transcript")) {
			fm["tags"] = [...existing, "transcript"];
		}

		fm["meeting_note"] = `[[${noteBasename}]]`;
		fm["pipeline_state"] = "titled";

		if (info) {
			fm["meeting_subject"] = info.subject;
			fm["is_recurring"] = info.isRecurring;
			// Prefer wiki-link invitees from meeting note, fall back to plain names
			if (wikiInvitees && wikiInvitees.length > 0) {
				fm["meeting_invitees"] = wikiInvitees;
			} else if (info.attendees.length > 0) {
				fm["meeting_invitees"] = info.attendees;
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
	const beforeStop = Date.now();
	onStatus?.("Waiting for transcript\u2026");
	try {
		// Poll recording API status until transcription completes
		for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
			await sleep(POLL_INTERVAL_MS);
			try {
				const {state} = await recordingStatus(baseUrl);
				if (state === "complete") break;
				if (state === "transcribing") {
					onStatus?.("Transcribing\u2026");
				}
			} catch {
				// Service may have shut down — fall through to file check
				break;
			}
			if (i === MAX_POLL_ATTEMPTS - 1) {
				onStatus?.("Transcript not ready \u2014 check recording service", "alert-circle", 6000, "warning");
				return;
			}
		}

		// Look for the transcript file in the vault
		const expectedPath = getTranscriptPath(notePath, transcriptFolderPath);
		let transcriptFile: TFile | null = null;

		// Wait for the file to appear — check expected path first, then scan folder
		for (let i = 0; i < 15 && !transcriptFile; i++) {
			await sleep(1000);
			const byPath = app.vault.getAbstractFileByPath(expectedPath);
			if (byPath instanceof TFile) {
				transcriptFile = byPath;
			} else {
				// Fallback: find the newest file in the transcript folder
				transcriptFile = findNewestFile(app, transcriptFolderPath, beforeStop);
			}
		}

		if (!transcriptFile) {
			onStatus?.("Transcript file not found \u2014 check output folder", "alert-circle", 6000, "warning");
			return;
		}

		// Enrich transcript with WhisperCal pipeline frontmatter
		onStatus?.("Enriching transcript\u2026");
		await enrichTranscriptFrontmatter(app, transcriptFile, notePath, info);

		// Link transcript to meeting note + set pipeline state.
		// Batch into a single processFrontMatter call to avoid a race with the
		// pipeline_state mirror handler that fires when the transcript is enriched.
		const transcriptBasename = transcriptFile.basename;
		await batchUpdateFrontmatter(app, notePath, {
			transcript: `[[${transcriptBasename}]]`,
			pipeline_state: "titled",
		});

		onStatus?.("Transcript linked", "check", 4000, "done");
	} catch (err) {
		console.error("[WhisperCal] Transcript linking failed:", err);
		onStatus?.("Failed to link transcript", "alert-circle", 6000, "warning");
	}
}

/** Check if a meeting note already has a transcript linked. */
export function hasLinkedTranscript(app: App, notePath: string): boolean {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return false;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return !!fm?.["transcript"];
}

/** Resolve and return the linked transcript TFile, if any. */
export function getLinkedTranscriptFile(app: App, notePath: string): TFile | null {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return null;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	return resolveWikiLink(app, fm, "transcript", notePath);
}
