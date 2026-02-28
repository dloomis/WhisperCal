import type {Plugin} from "obsidian";
import type {RecordingSession} from "../services/RecordingTypes";

function parseCodeBlockContent(source: string): RecordingSession | null {
	const lines = source.trim().split("\n");
	const map = new Map<string, string>();
	for (const line of lines) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.substring(0, colonIndex).trim();
		const value = line.substring(colonIndex + 1).trim();
		map.set(key, value);
	}

	const eventId = map.get("eventId");
	const subject = map.get("subject");
	const date = map.get("date");
	if (!eventId || !subject || !date) return null;

	return {eventId, subject, date};
}

/**
 * Registers the whisper-recording code block processor.
 * The code block stores session metadata (eventId, subject, date) used by
 * NoteRecordingAction to show the mic icon. It renders nothing visible —
 * recording status is shown in the status bar instead.
 */
export function registerRecordingCodeBlock(
	plugin: Plugin,
): void {
	plugin.registerMarkdownCodeBlockProcessor(
		"whisper-recording",
		(source, el) => {
			const session = parseCodeBlockContent(source);
			if (!session) {
				el.createDiv({
					cls: "whisper-cal-error",
					text: "Invalid recording block: missing eventId, subject, or date",
				});
				return;
			}

			// Hidden block — metadata only, no visible UI
			el.addClass("whisper-cal-recording-block");
		},
	);
}
