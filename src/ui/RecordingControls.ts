import {setIcon} from "obsidian";
import type {RecordingManager} from "../services/RecordingManager";
import type {RecordingSession, RecordingSessionState} from "../services/RecordingTypes";

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

export interface RecordingControlsHandle {
	el: HTMLElement;
	destroy: () => void;
}

/**
 * Renders recording controls (record/pause/stop + elapsed time) into a container.
 * Returns a handle with the element and a destroy function for cleanup.
 */
export function renderRecordingControls(
	container: HTMLElement,
	recordingManager: RecordingManager,
	session: RecordingSession,
): RecordingControlsHandle {
	const el = container.createDiv({cls: "whisper-cal-recording"});
	let timerId: number | null = null;
	let unsubscribe: (() => void) | null = null;

	const render = (state: RecordingSessionState) => {
		el.empty();
		if (timerId !== null) {
			window.clearInterval(timerId);
			timerId = null;
		}

		const isThisSession =
			(state.status === "recording" || state.status === "paused" || state.status === "saving") &&
			state.session.eventId === session.eventId;
		const isBusy =
			(state.status === "recording" || state.status === "paused" || state.status === "saving") &&
			!isThisSession;

		if (state.status === "idle" || state.status === "error" || !isThisSession) {
			// Show record button (disabled if another session is active)
			const recordBtn = el.createEl("button", {
				cls: "whisper-cal-btn whisper-cal-btn-record",
			});
			const dotSpan = recordBtn.createSpan({cls: "whisper-cal-record-dot"});
			dotSpan.createSpan();
			recordBtn.createSpan({text: "Record"});
			recordBtn.disabled = isBusy;
			if (isBusy) {
				recordBtn.title = "Another recording is in progress";
			}
			recordBtn.addEventListener("click", () => {
				void recordingManager.startRecording(session);
			});

			if (state.status === "error") {
				el.createDiv({
					cls: "whisper-cal-recording-error",
					text: state.message,
				});
				const dismissBtn = el.createEl("button", {
					cls: "whisper-cal-btn whisper-cal-btn-secondary whisper-cal-btn-small",
					text: "Dismiss",
				});
				dismissBtn.addEventListener("click", () => {
					recordingManager.dismissError();
				});
			}
			return;
		}

		if (state.status === "saving") {
			el.createDiv({
				cls: "whisper-cal-recording-status",
				text: "Saving...",
			});
			return;
		}

		// Active recording controls
		const controls = el.createDiv({cls: "whisper-cal-recording-controls"});

		// Elapsed time with pulsing dot
		const timerEl = controls.createDiv({cls: "whisper-cal-recording-timer"});
		const dot = timerEl.createSpan({cls: "whisper-cal-recording-dot-live"});
		dot.createSpan();
		if (state.status === "paused") {
			dot.addClass("whisper-cal-recording-dot-paused");
		}
		const timeText = timerEl.createSpan({cls: "whisper-cal-recording-time"});
		timeText.setText(formatElapsed(getElapsedMs(state)));

		// Update timer every second while recording
		if (state.status === "recording") {
			timerId = window.setInterval(() => {
				const currentState = recordingManager.getState();
				timeText.setText(formatElapsed(getElapsedMs(currentState)));
			}, 1000);
		}

		// Buttons row
		const buttonsEl = controls.createDiv({cls: "whisper-cal-recording-buttons"});

		if (state.status === "recording") {
			const pauseBtn = buttonsEl.createEl("button", {
				cls: "whisper-cal-btn whisper-cal-btn-secondary whisper-cal-btn-small",
			});
			const pauseIcon = pauseBtn.createSpan({cls: "whisper-cal-card-icon"});
			setIcon(pauseIcon, "pause");
			pauseBtn.createSpan({text: "Pause"});
			pauseBtn.addEventListener("click", () => {
				recordingManager.pauseRecording();
			});
		} else {
			const resumeBtn = buttonsEl.createEl("button", {
				cls: "whisper-cal-btn whisper-cal-btn-secondary whisper-cal-btn-small",
			});
			const resumeIcon = resumeBtn.createSpan({cls: "whisper-cal-card-icon"});
			setIcon(resumeIcon, "play");
			resumeBtn.createSpan({text: "Resume"});
			resumeBtn.addEventListener("click", () => {
				recordingManager.resumeRecording();
			});
		}

		const stopBtn = buttonsEl.createEl("button", {
			cls: "whisper-cal-btn whisper-cal-btn-stop whisper-cal-btn-small",
		});
		const stopIcon = stopBtn.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(stopIcon, "square");
		stopBtn.createSpan({text: "Stop"});
		stopBtn.addEventListener("click", () => {
			void recordingManager.stopRecording();
		});
	};

	// Initial render
	render(recordingManager.getState());

	// Subscribe to state changes
	unsubscribe = recordingManager.onChange((state) => {
		render(state);
	});

	const destroy = () => {
		if (timerId !== null) {
			window.clearInterval(timerId);
			timerId = null;
		}
		unsubscribe?.();
		unsubscribe = null;
	};

	return {el, destroy};
}
