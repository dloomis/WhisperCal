import {setIcon} from "obsidian";
import type {RecordingManager} from "../services/RecordingManager";
import type {RecordingSessionState} from "../services/RecordingTypes";
import type {TranscriptionManager} from "../services/TranscriptionManager";
import type {TranscriptionState} from "../services/TranscriptionTypes";

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getElapsedMs(state: RecordingSessionState): number {
	if (state.status === "recording") {
		return Date.now() - state.startedAt - state.pausedDuration;
	}
	if (state.status === "paused") {
		return state.pausedAt - state.startedAt - state.pausedDuration;
	}
	return 0;
}

export class StatusBarRecording {
	private el: HTMLElement;
	private recordingEl: HTMLElement;
	private transcriptionEl: HTMLElement;
	private recordingManager: RecordingManager;
	private transcriptionManager: TranscriptionManager | null = null;
	private unsubscribeRecording: (() => void) | null = null;
	private unsubscribeTranscription: (() => void) | null = null;
	private recordingTimerId: number | null = null;
	private transcriptionTimerId: number | null = null;
	private transcribeStartedAt: number | null = null;

	constructor(el: HTMLElement, recordingManager: RecordingManager, transcriptionManager?: TranscriptionManager) {
		this.el = el;
		this.el.addClass("whisper-cal-statusbar");
		this.recordingEl = this.el.createDiv({cls: "whisper-cal-statusbar-segment"});
		this.transcriptionEl = this.el.createDiv({cls: "whisper-cal-statusbar-segment"});
		this.recordingManager = recordingManager;
		this.transcriptionManager = transcriptionManager ?? null;

		this.renderRecording(this.recordingManager.getState());
		if (this.transcriptionManager) {
			this.renderTranscription(this.transcriptionManager.getState());
		}
		this.updateVisibility();

		this.unsubscribeRecording = recordingManager.onChange(() => {
			this.renderRecording(this.recordingManager.getState());
			this.updateVisibility();
		});
		if (this.transcriptionManager) {
			this.unsubscribeTranscription = this.transcriptionManager.onChange(() => {
				this.renderTranscription(this.transcriptionManager!.getState());
				this.updateVisibility();
			});
		}
	}

	destroy(): void {
		this.clearRecordingTimer();
		this.clearTranscriptionTimer();
		this.unsubscribeRecording?.();
		this.unsubscribeRecording = null;
		this.unsubscribeTranscription?.();
		this.unsubscribeTranscription = null;
		this.el.empty();
	}

	private updateVisibility(): void {
		const recEmpty = this.recordingEl.childElementCount === 0;
		const txnEmpty = this.transcriptionEl.childElementCount === 0;
		this.el.toggleClass("whisper-cal-statusbar-hidden", recEmpty && txnEmpty);
	}

	private renderTranscription(state: TranscriptionState): void {
		this.clearTranscriptionTimer();
		this.transcriptionEl.empty();

		if (state.status === "idle" || state.status === "error") {
			this.transcribeStartedAt = null;
			return;
		}

		if (state.status === "saving") {
			this.transcribeStartedAt = null;
			this.transcriptionEl.createSpan({
				cls: "whisper-cal-statusbar-saving",
				text: "Saving transcript...",
			});
			return;
		}

		if (state.status === "uploading") {
			this.transcriptionEl.createSpan({
				cls: "whisper-cal-statusbar-saving",
				text: "Uploading...",
			});
			return;
		}

		// Transcribing or polling — show pulsing dot + subject + status label + elapsed timer
		if (this.transcribeStartedAt === null) {
			this.transcribeStartedAt = Date.now();
		}

		const dot = this.transcriptionEl.createSpan({cls: "whisper-cal-statusbar-dot whisper-cal-statusbar-dot-transcribing"});
		dot.createSpan();

		this.transcriptionEl.createSpan({
			cls: "whisper-cal-statusbar-subject",
			text: state.request.session.subject,
		});

		const label = state.status === "polling" && state.pollingStatus === "queued" ? "Queued" : "Transcribing";
		const audioDuration = state.status === "polling" ? state.audioDuration : undefined;
		const durationSuffix = audioDuration ? ` / ${formatElapsed(audioDuration * 1000)} audio` : "";

		const startedAt = this.transcribeStartedAt;
		const timeEl = this.transcriptionEl.createSpan({cls: "whisper-cal-statusbar-time"});
		const updateText = () => {
			const elapsed = formatElapsed(Date.now() - startedAt);
			timeEl.setText(`${label} ${elapsed}${durationSuffix}`);
		};
		updateText();
		this.transcriptionTimerId = window.setInterval(updateText, 1000);
	}

	private clearRecordingTimer(): void {
		if (this.recordingTimerId !== null) {
			window.clearInterval(this.recordingTimerId);
			this.recordingTimerId = null;
		}
	}

	private clearTranscriptionTimer(): void {
		if (this.transcriptionTimerId !== null) {
			window.clearInterval(this.transcriptionTimerId);
			this.transcriptionTimerId = null;
		}
	}

	private renderRecording(state: RecordingSessionState): void {
		this.clearRecordingTimer();
		this.recordingEl.empty();

		if (state.status === "idle" || state.status === "error") {
			return;
		}

		if (state.status === "saving") {
			this.recordingEl.createSpan({
				cls: "whisper-cal-statusbar-saving",
				text: "Saving...",
			});
			return;
		}

		// Recording or paused — show full controls
		const dot = this.recordingEl.createSpan({cls: "whisper-cal-statusbar-dot"});
		dot.createSpan();
		if (state.status === "paused") {
			dot.addClass("whisper-cal-statusbar-dot-paused");
		}

		this.recordingEl.createSpan({
			cls: "whisper-cal-statusbar-subject",
			text: state.session.subject,
		});

		const timeEl = this.recordingEl.createSpan({cls: "whisper-cal-statusbar-time"});
		timeEl.setText(formatElapsed(getElapsedMs(state)));

		if (state.status === "recording") {
			this.recordingTimerId = window.setInterval(() => {
				const current = this.recordingManager.getState();
				timeEl.setText(formatElapsed(getElapsedMs(current)));
			}, 1000);
		}

		if (state.status === "recording") {
			const pauseBtn = this.recordingEl.createSpan({
				cls: "whisper-cal-statusbar-btn clickable-icon",
				attr: {"aria-label": "Pause recording"},
			});
			setIcon(pauseBtn, "pause");
			pauseBtn.addEventListener("click", () => {
				this.recordingManager.pauseRecording();
			});
		} else {
			const resumeBtn = this.recordingEl.createSpan({
				cls: "whisper-cal-statusbar-btn clickable-icon",
				attr: {"aria-label": "Resume recording"},
			});
			setIcon(resumeBtn, "play");
			resumeBtn.addEventListener("click", () => {
				this.recordingManager.resumeRecording();
			});
		}

		const stopBtn = this.recordingEl.createSpan({
			cls: "whisper-cal-statusbar-btn whisper-cal-statusbar-btn-stop clickable-icon",
			attr: {"aria-label": "Stop recording"},
		});
		setIcon(stopBtn, "square");
		stopBtn.addEventListener("click", () => {
			void this.recordingManager.stopRecording();
		});
	}
}
