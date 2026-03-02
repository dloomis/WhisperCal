import {App, Notice} from "obsidian";
import {findRecordingsNear, setSessionTitle} from "./MacWhisperDb";
import {createTranscriptFile} from "./TranscriptWriter";
import {RecordingSuggestModal} from "../ui/RecordingSuggestModal";
import {updateFrontmatter} from "../utils/frontmatter";
import {formatDate} from "../utils/time";
import {sanitizeFilename} from "../utils/sanitize";
import type {EventAttendee} from "../types";

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
	windowMinutes?: number;
}): Promise<boolean> {
	const {app, meetingStart, notePath, subject, timezone, transcriptFolderPath, attendees, windowMinutes} = opts;

	const recordings = await findRecordingsNear(meetingStart, windowMinutes);

	if (recordings.length === 0) {
		new Notice("No matching recording found");
		return false;
	}

	let selected;
	if (recordings.length === 1) {
		selected = recordings[0]!;
	} else {
		const modal = new RecordingSuggestModal(app, recordings);
		selected = await modal.prompt();
	}

	if (!selected) return false;

	// Set MacWhisper title to match the note filename (without folder or .md)
	const title = notePath.split("/").pop()?.replace(/\.md$/i, "") ?? `${formatDate(meetingStart, timezone)} ${sanitizeFilename(subject)}`;
	if (!await setSessionTitle(selected.sessionId, title)) {
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		new Notice("Failed to update MacWhisper session title");
		return false;
	}

	// Phase 1: Write session ID to note frontmatter (fast)
	try {
		await updateFrontmatter(app, notePath, "macwhisper_session_id", selected.sessionId);
	} catch (err) {
		console.error("[WhisperCal] Failed to update frontmatter — YAML may be malformed:", err);
		new Notice("Failed to update note frontmatter (check for invalid YAML)");
		return false;
	}
	new Notice("Recording linked to note");

	// Phase 2: Create transcript file in background (fire-and-forget)
	void (async () => {
		const notice = new Notice("Creating transcript\u2026", 0);
		try {
			const transcriptPath = await createTranscriptFile({
				app,
				notePath,
				sessionId: selected.sessionId,
				transcriptFolderPath,
				recordingStart: selected.recordingStart,
				timezone,
				calendarEvent: subject,
				calendarAttendees: attendees.map(a => a.name),
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
