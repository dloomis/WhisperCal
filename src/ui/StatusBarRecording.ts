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
	private recordingManager: RecordingManager;
	private transcriptionManager: TranscriptionManager | null = null;
	private unsubscribeRecording: (() => void) | null = null;
	private unsubscribeTranscription: (() => void) | null = null;
	private timerId: number | null = null;

	constructor(el: HTMLElement, recordingManager: RecordingManager, transcriptionManager?: TranscriptionManager) {
		this.el = el;
		this.el.addClass("whisper-cal-statusbar");
		this.recordingManager = recordingManager;
		this.transcriptionManager = transcriptionManager ?? null;

		this.renderCurrent();
		this.unsubscribeRecording = recordingManager.onChange(() => this.renderCurrent());
		if (this.transcriptionManager) {
			this.unsubscribeTranscription = this.transcriptionManager.onChange(() => this.renderCurrent());
		}
	}

	destroy(): void {
		this.clearTimer();
		this.unsubscribeRecording?.();
		this.unsubscribeRecording = null;
		this.unsubscribeTranscription?.();
		this.unsubscribeTranscription = null;
		this.el.empty();
	}

	private renderCurrent(): void {
		const transcriptionState = this.transcriptionManager?.getState();
		if (transcriptionState && transcriptionState.status !== "idle") {
			this.renderTranscription(transcriptionState);
		} else {
			this.render(this.recordingManager.getState());
		}
	}

	private renderTranscription(state: TranscriptionState): void {
		this.clearTimer();
		this.el.empty();

		if (state.status === "idle" || state.status === "error") {
			return;
		}

		if (state.status === "saving") {
			this.el.createSpan({
				cls: "whisper-cal-statusbar-saving",
				text: "Saving transcript...",
			});
			return;
		}

		// Transcribing — show pulsing dot + subject + "Transcribing..."
		const dot = this.el.createSpan({cls: "whisper-cal-statusbar-dot whisper-cal-statusbar-dot-transcribing"});
		dot.createSpan();

		this.el.createSpan({
			cls: "whisper-cal-statusbar-subject",
			text: state.request.session.subject,
		});

		this.el.createSpan({
			cls: "whisper-cal-statusbar-time",
			text: "Transcribing...",
		});
	}

	private clearTimer(): void {
		if (this.timerId !== null) {
			window.clearInterval(this.timerId);
			this.timerId = null;
		}
	}

	private render(state: RecordingSessionState): void {
		this.clearTimer();
		this.el.empty();

		if (state.status === "idle" || state.status === "error") {
			// Hidden when idle — CSS hides :empty
			return;
		}

		if (state.status === "saving") {
			this.el.createSpan({
				cls: "whisper-cal-statusbar-saving",
				text: "Saving...",
			});
			return;
		}

		// Recording or paused — show full controls
		const dot = this.el.createSpan({cls: "whisper-cal-statusbar-dot"});
		dot.createSpan();
		if (state.status === "paused") {
			dot.addClass("whisper-cal-statusbar-dot-paused");
		}

		this.el.createSpan({
			cls: "whisper-cal-statusbar-subject",
			text: state.session.subject,
		});

		const timeEl = this.el.createSpan({cls: "whisper-cal-statusbar-time"});
		timeEl.setText(formatElapsed(getElapsedMs(state)));

		if (state.status === "recording") {
			this.timerId = window.setInterval(() => {
				const current = this.recordingManager.getState();
				timeEl.setText(formatElapsed(getElapsedMs(current)));
			}, 1000);
		}

		if (state.status === "recording") {
			const pauseBtn = this.el.createSpan({
				cls: "whisper-cal-statusbar-btn clickable-icon",
				attr: {"aria-label": "Pause recording"},
			});
			setIcon(pauseBtn, "pause");
			pauseBtn.addEventListener("click", () => {
				this.recordingManager.pauseRecording();
			});
		} else {
			const resumeBtn = this.el.createSpan({
				cls: "whisper-cal-statusbar-btn clickable-icon",
				attr: {"aria-label": "Resume recording"},
			});
			setIcon(resumeBtn, "play");
			resumeBtn.addEventListener("click", () => {
				this.recordingManager.resumeRecording();
			});
		}

		const stopBtn = this.el.createSpan({
			cls: "whisper-cal-statusbar-btn whisper-cal-statusbar-btn-stop clickable-icon",
			attr: {"aria-label": "Stop recording"},
		});
		setIcon(stopBtn, "square");
		stopBtn.addEventListener("click", () => {
			void this.recordingManager.stopRecording();
		});
	}
}
