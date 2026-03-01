import {App, Notice} from "obsidian";
import {findRecordingsNear, setSessionTitle} from "./MacWhisperDb";
import {createTranscriptFile} from "./TranscriptWriter";
import {RecordingSuggestModal} from "../ui/RecordingSuggestModal";
import {updateFrontmatter} from "../utils/frontmatter";
import {formatDate} from "../utils/time";

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
	windowMinutes?: number;
}): Promise<boolean> {
	const {app, meetingStart, notePath, subject, timezone, transcriptFolderPath, windowMinutes} = opts;

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

	// Set title in MacWhisper DB first — only proceed if successful
	const date = formatDate(meetingStart, timezone);
	const title = `${date} ${subject}`;
	if (!await setSessionTitle(selected.sessionId, title)) {
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		new Notice("Failed to update MacWhisper session title");
		return false;
	}

	// Write session ID to note frontmatter
	await updateFrontmatter(app, notePath, "macwhisper_session_id", selected.sessionId);

	// Create transcript file from MacWhisper DB
	const transcriptPath = await createTranscriptFile({
		app,
		notePath,
		sessionId: selected.sessionId,
		transcriptFolderPath,
	});
	if (transcriptPath) {
		new Notice("Recording and transcript linked to note");
	} else {
		new Notice("Recording linked to note");
	}
	return true;
}
