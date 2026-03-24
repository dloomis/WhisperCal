import {App, Notice} from "obsidian";
import {findRecordingsNear, hasTranscriptLines, type MacWhisperRecording} from "./MacWhisperDb";
import {createTranscriptFile} from "./TranscriptWriter";
import {RecordingSuggestModal} from "../ui/RecordingSuggestModal";
import {updateFrontmatter} from "../utils/frontmatter";
import {getLinkedSessionIds} from "../utils/vault";
import {sleep} from "../utils/time";
import type {EventAttendee} from "../types";
import {parseDisplayName} from "../utils/nameParser";

/**
 * Internal helper — performs the actual recording→note link: sets MacWhisper
 * title, writes session ID to frontmatter, and creates transcript file.
 */
async function performLink(opts: {
	app: App;
	sessionId: string;
	recordingStart: Date;
	notePath: string;
	subject: string;
	timezone: string;
	transcriptFolderPath: string;
	attendees: EventAttendee[];
	isRecurring: boolean;
}): Promise<boolean> {
	const {app, sessionId, recordingStart, notePath, subject, timezone, transcriptFolderPath, attendees, isRecurring} = opts;

	// Write session ID to note frontmatter
	try {
		await updateFrontmatter(app, notePath, "macwhisper_session_id", sessionId);
	} catch (err) {
		console.error("[WhisperCal] Failed to update frontmatter — YAML may be malformed:", err);
		new Notice("Failed to update note frontmatter (check for invalid YAML)");
		return false;
	}
	new Notice("Recording linked to note");

	// Phase 2: Create transcript file in background (fire-and-forget)
	// Polls for transcript lines in case MacWhisper is still transcribing.
	void (async () => {
		const notice = new Notice("Creating transcript\u2026", 0);
		try {
			// Wait for MacWhisper transcription to finish
			const TRANSCRIPTION_POLL_INTERVAL_MS = 3000;
			const TRANSCRIPTION_MAX_ATTEMPTS = 60; // ~3 minutes
			let ready = await hasTranscriptLines(sessionId);
			if (!ready) {
				notice.setMessage("Waiting for MacWhisper transcription\u2026");
				for (let i = 0; i < TRANSCRIPTION_MAX_ATTEMPTS && !ready; i++) {
					await sleep(TRANSCRIPTION_POLL_INTERVAL_MS);
					ready = await hasTranscriptLines(sessionId);
				}
				if (!ready) {
					notice.setMessage("Transcription still in progress \u2014 try linking again later");
					setTimeout(() => notice.hide(), 6000);
					return;
				}
			}

			notice.setMessage("Creating transcript\u2026");
			const transcriptPath = await createTranscriptFile({
				app,
				notePath,
				sessionId,
				transcriptFolderPath,
				recordingStart,
				timezone,
				calendarEvent: subject,
				calendarAttendees: attendees.map(a => parseDisplayName(a.name, a.email)),
				isRecurring,
			});
			if (transcriptPath) {
				notice.setMessage("Transcript linked to note");
			} else {
				notice.hide();
			}
		} catch (err) {
			console.error("[WhisperCal] Transcript creation failed:", err);
			notice.setMessage("Transcript creation failed");
		}
		setTimeout(() => notice.hide(), 4000);
	})();

	return true;
}

/**
 * Search for a MacWhisper recording near a meeting start time,
 * let the user pick one (if multiple), then link it to the note.
 *
 * Returns true if a recording was linked, false otherwise.
 */
export async function linkRecording(opts: {
	app: App;
	meetingStart: Date;
	notePath: string;
	subject: string;
	timezone: string;
	transcriptFolderPath: string;
	attendees: EventAttendee[];
	isRecurring: boolean;
	windowMinutes?: number;
}): Promise<boolean> {
	const {app, meetingStart, notePath, subject, timezone, transcriptFolderPath, attendees, isRecurring, windowMinutes} = opts;

	const allRecordings = await findRecordingsNear(meetingStart, windowMinutes);

	// Exclude recordings already linked to any note in the vault
	const linked = getLinkedSessionIds(app);
	const recordings = allRecordings.filter(r => !linked.has(r.sessionId));

	if (recordings.length === 0) {
		new Notice("No matching recording found");
		return false;
	}

	const modal = new RecordingSuggestModal(app, recordings);
	const selected = await modal.prompt();

	if (!selected) return false;

	return performLink({
		app,
		sessionId: selected.sessionId,
		recordingStart: selected.recordingStart,
		notePath,
		subject,
		timezone,
		transcriptFolderPath,
		attendees,
		isRecurring,
	});
}

/**
 * Link a known MacWhisper recording to an existing note.
 * Used by the "unlinked recordings" feature where the session is already identified.
 */
export async function linkKnownRecording(opts: {
	app: App;
	session: MacWhisperRecording;
	notePath: string;
	subject: string;
	timezone: string;
	transcriptFolderPath: string;
	attendees?: EventAttendee[];
	isRecurring?: boolean;
}): Promise<boolean> {
	return performLink({
		...opts,
		sessionId: opts.session.sessionId,
		recordingStart: opts.session.recordingStart,
		attendees: opts.attendees ?? [],
		isRecurring: opts.isRecurring ?? false,
	});
}
