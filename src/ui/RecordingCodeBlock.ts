import type {Plugin} from "obsidian";
import type {RecordingManager} from "../services/RecordingManager";
import type {RecordingSession} from "../services/RecordingTypes";
import {renderRecordingControls} from "./RecordingControls";

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

export function registerRecordingCodeBlock(
	plugin: Plugin,
	recordingManager: RecordingManager,
): void {
	plugin.registerMarkdownCodeBlockProcessor(
		"whisper-recording",
		(source, el, _ctx) => {
			const session = parseCodeBlockContent(source);
			if (!session) {
				el.createDiv({
					cls: "whisper-cal-error",
					text: "Invalid recording block: missing eventId, subject, or date",
				});
				return;
			}

			const handle = renderRecordingControls(el, recordingManager, session);

			// Clean up when the element is removed from DOM
			const observer = new MutationObserver(() => {
				if (!el.isConnected) {
					handle.destroy();
					observer.disconnect();
				}
			});
			// Observe the parent — when el is removed, we get notified
			if (el.parentElement) {
				observer.observe(el.parentElement, {childList: true});
			}
		},
	);
}
