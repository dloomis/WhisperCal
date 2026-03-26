import {App, SuggestModal} from "obsidian";
import type {MacWhisperRecording} from "../services/MacWhisperDb";
import {formatRecordingDuration, getHour12} from "../utils/time";

/** Ceil a Date to the next minute (matches MacWhisper's display rounding). */
function ceilToMinute(d: Date): Date {
	const ms = d.getTime();
	const remainder = ms % 60000;
	return remainder === 0 ? d : new Date(ms + 60000 - remainder);
}

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
			const time = r.recordingStart.toLocaleTimeString(undefined, {hour12: getHour12()});
			return title.includes(q) || time.includes(q);
		});
	}

	renderSuggestion(recording: MacWhisperRecording, el: HTMLElement): void {
		const title = recording.title || "Untitled recording";
		const timeOpts: Intl.DateTimeFormatOptions = {
			hour: "numeric",
			minute: "2-digit",
			hour12: getHour12(),
		};
		const dateOpts: Intl.DateTimeFormatOptions = {
			month: "short",
			day: "numeric",
		};
		const displayEnd = ceilToMinute(recording.dateCreated ?? recording.recordingStart);
		const displayStart = recording.durationSeconds > 0
			? ceilToMinute(new Date(displayEnd.getTime() - recording.durationSeconds * 1000))
			: displayEnd;
		const startDate = displayStart.toLocaleDateString(undefined, dateOpts);
		const startTime = displayStart.toLocaleTimeString(undefined, timeOpts);
		const endTime = recording.dateCreated
			? recording.dateCreated.toLocaleTimeString(undefined, timeOpts)
			: "";
		const duration = formatRecordingDuration(recording.durationSeconds);
		const speakers = recording.speakerCount > 0
			? `${recording.speakerCount} speaker${recording.speakerCount === 1 ? "" : "s"}`
			: "";
		const timeRange = endTime ? `${startTime} – ${endTime}` : startTime;

		el.createDiv({text: title});
		const meta = [startDate, timeRange, duration, speakers].filter(Boolean).join(" \u00B7 ");
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
