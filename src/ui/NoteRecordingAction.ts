import {MarkdownView, TFile} from "obsidian";
import type {App} from "obsidian";
import type {RecordingManager} from "../services/RecordingManager";
import type {RecordingSession} from "../services/RecordingTypes";

function parseSessionFromContent(content: string): RecordingSession | null {
	const match = content.match(/```whisper-recording\n([\s\S]*?)```/);
	if (!match) return null;

	const block = match[1] ?? "";
	const map = new Map<string, string>();
	for (const line of block.trim().split("\n")) {
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
 * Manages a mic icon in the view header of meeting notes.
 * Appears when a markdown file with a whisper-recording block is active.
 */
export class NoteRecordingAction {
	private app: App;
	private recordingManager: RecordingManager;
	private unsubscribeWorkspace: (() => void) | null = null;
	private unsubscribeRecording: (() => void) | null = null;
	private activeActionEl: HTMLElement | null = null;
	private activeView: MarkdownView | null = null;
	private activeSession: RecordingSession | null = null;

	constructor(app: App, recordingManager: RecordingManager) {
		this.app = app;
		this.recordingManager = recordingManager;

		const ref = this.app.workspace.on("active-leaf-change", () => {
			this.onLeafChange();
		});
		this.unsubscribeWorkspace = () => this.app.workspace.offref(ref);

		this.unsubscribeRecording = recordingManager.onChange(() => {
			this.updateIcon();
		});

		// Check current leaf on init
		this.onLeafChange();
	}

	destroy(): void {
		this.removeAction();
		this.unsubscribeWorkspace?.();
		this.unsubscribeWorkspace = null;
		this.unsubscribeRecording?.();
		this.unsubscribeRecording = null;
	}

	private onLeafChange(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !(view.file instanceof TFile)) {
			this.removeAction();
			return;
		}

		// Read file content to check for whisper-recording block
		const content = view.data;
		if (!content) {
			this.removeAction();
			return;
		}
		const session = parseSessionFromContent(content);

		if (!session) {
			this.removeAction();
			return;
		}

		// Same view + same session — just update icon state
		if (this.activeView === view && this.activeSession?.eventId === session.eventId) {
			this.updateIcon();
			return;
		}

		// Different note — rebuild
		this.removeAction();
		this.activeView = view;
		this.activeSession = session;
		this.addAction();
	}

	private addAction(): void {
		if (!this.activeView || !this.activeSession) return;

		const session = this.activeSession;
		this.activeActionEl = this.activeView.addAction(
			"mic",
			"Record meeting",
			() => {
				const state = this.recordingManager.getState();
				const isThisSession =
					(state.status === "recording" || state.status === "paused") &&
					state.session.eventId === session.eventId;
				const isBusy =
					(state.status === "recording" || state.status === "paused" || state.status === "saving");

				if (isThisSession || isBusy) return;
				void this.recordingManager.startRecording(session);
			},
		);
		this.activeActionEl.addClass("whisper-cal-note-rec-action");
		this.updateIcon();
	}

	private removeAction(): void {
		this.activeActionEl?.remove();
		this.activeActionEl = null;
		this.activeView = null;
		this.activeSession = null;
	}

	private updateIcon(): void {
		if (!this.activeActionEl || !this.activeSession) return;

		const state = this.recordingManager.getState();
		const isThisSession =
			(state.status === "recording" || state.status === "paused" || state.status === "saving") &&
			state.session.eventId === this.activeSession.eventId;
		const isBusy =
			(state.status === "recording" || state.status === "paused" || state.status === "saving") &&
			!isThisSession;

		this.activeActionEl.removeClass("whisper-cal-note-rec-active");
		this.activeActionEl.removeClass("whisper-cal-note-rec-disabled");

		if (isThisSession) {
			this.activeActionEl.addClass("whisper-cal-note-rec-active");
			this.activeActionEl.ariaLabel = "Recording in progress";
		} else if (isBusy) {
			this.activeActionEl.addClass("whisper-cal-note-rec-disabled");
			this.activeActionEl.ariaLabel = "Another recording in progress";
		} else {
			this.activeActionEl.ariaLabel = "Record meeting";
		}
	}
}
