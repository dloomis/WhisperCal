import {App, SuggestModal} from "obsidian";
import type {MacWhisperRecording} from "../services/MacWhisperDb";
import {formatRecordingDuration} from "../utils/time";

export class RecordingSuggestModal extends SuggestModal<MacWhisperRecording> {
	private recordings: MacWhisperRecording[];
	private resolve: ((value: MacWhisperRecording | null) => void) | null = null;
	private selected: MacWhisperRecording | null = null;

	constructor(app: App, recordings: MacWhisperRecording[]) {
		super(app);
		this.recordings = recordings;
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.setPlaceholder("Choose a MacWhisper recording");
	}

	prompt(): Promise<MacWhisperRecording | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	getSuggestions(query: string): MacWhisperRecording[] {
		const q = query.toLowerCase();
		if (!q) return this.recordings;
		return this.recordings.filter(r => {
			const title = r.title?.toLowerCase() ?? "";
			const time = r.recordingStart.toLocaleTimeString();
			return title.includes(q) || time.includes(q);
		});
	}

	renderSuggestion(recording: MacWhisperRecording, el: HTMLElement): void {
		const title = recording.title || "Untitled recording";
		// Use dateCreated (matches MacWhisper UI timestamp), fall back to recordingStart
		const displayDate = recording.dateCreated ?? recording.recordingStart;
		const time = displayDate.toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
		});
		const date = displayDate.toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
		});
		const duration = formatRecordingDuration(recording.durationSeconds);

		el.createDiv({text: title});
		const meta = [date, time, duration].filter(Boolean).join(" \u00B7 ");
		el.createDiv({cls: "suggestion-note", text: meta});
	}

	onChooseSuggestion(recording: MacWhisperRecording): void {
		this.selected = recording;
	}

	onClose(): void {
		super.onClose();
		// Defer to next tick — onChooseSuggestion fires after onClose
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(this.selected);
				this.resolve = null;
			}
		}, 0);
	}
}
