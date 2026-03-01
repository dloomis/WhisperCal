import {MarkdownView, TFile} from "obsidian";
import type {App} from "obsidian";
import type {RecordingManager} from "../services/RecordingManager";
import type {TranscriptionManager} from "../services/TranscriptionManager";
import type {RecordingSession} from "../services/RecordingTypes";
import type {TranscriptionRequest} from "../services/TranscriptionTypes";

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

function getRecordingPath(app: App, file: TFile): string | null {
	const cache = app.metadataCache.getFileCache(file);
	const recording = (cache?.frontmatter as Record<string, unknown> | undefined)?.["recording"];
	if (typeof recording !== "string" || !recording) return null;

	// Extract path from wiki-link format [[filename.ext]]
	const wikiMatch = recording.match(/^\[\[(.+?)]]$/);
	const linkTarget = wikiMatch ? wikiMatch[1] as string : recording;

	// Resolve via metadataCache to find the actual vault path
	const resolved = app.metadataCache.getFirstLinkpathDest(linkTarget, file.path);
	return resolved?.path ?? null;
}

function hasTranscript(app: App, file: TFile): boolean {
	const cache = app.metadataCache.getFileCache(file);
	const transcript = (cache?.frontmatter as Record<string, unknown> | undefined)?.["transcript"];
	return typeof transcript === "string" && transcript.length > 0;
}

/**
 * Manages a transcribe icon in the view header of meeting notes.
 * Appears when a markdown file has a recording but no transcript.
 */
export class NoteTranscriptionAction {
	private app: App;
	private transcriptionManager: TranscriptionManager;
	private unsubscribeWorkspace: (() => void) | null = null;
	private unsubscribeTranscription: (() => void) | null = null;
	private unsubscribeRecording: (() => void) | null = null;
	private unsubscribeMetadata: (() => void) | null = null;
	private activeActionEl: HTMLElement | null = null;
	private activeView: MarkdownView | null = null;
	private activeSession: RecordingSession | null = null;

	constructor(app: App, transcriptionManager: TranscriptionManager, recordingManager?: RecordingManager) {
		this.app = app;
		this.transcriptionManager = transcriptionManager;

		const leafRef = this.app.workspace.on("active-leaf-change", () => {
			this.onLeafChange();
		});
		this.unsubscribeWorkspace = () => this.app.workspace.offref(leafRef);

		this.unsubscribeTranscription = transcriptionManager.onChange(() => {
			this.updateIcon();
		});

		if (recordingManager) {
			this.unsubscribeRecording = recordingManager.onChange(() => {
				// Recording just finished — frontmatter update is async, so
				// defer to let the metadata cache settle before re-evaluating.
				window.setTimeout(() => this.onLeafChange(), 200);
			});
		}

		const metaRef = this.app.metadataCache.on("changed", (file) => {
			if (this.activeView?.file instanceof TFile && file.path === this.activeView.file.path) {
				this.onLeafChange();
			}
		});
		this.unsubscribeMetadata = () => this.app.metadataCache.offref(metaRef);

		this.onLeafChange();
	}

	destroy(): void {
		this.removeAction();
		this.unsubscribeWorkspace?.();
		this.unsubscribeWorkspace = null;
		this.unsubscribeTranscription?.();
		this.unsubscribeTranscription = null;
		this.unsubscribeRecording?.();
		this.unsubscribeRecording = null;
		this.unsubscribeMetadata?.();
		this.unsubscribeMetadata = null;
	}

	private onLeafChange(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !(view.file instanceof TFile)) {
			this.removeAction();
			return;
		}

		const file = view.file;
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

		const recordingPath = getRecordingPath(this.app, file);
		const transcriptExists = hasTranscript(this.app, file);

		// Hide if no recording or transcript already exists
		if (!recordingPath || transcriptExists) {
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
		this.addAction(recordingPath);
	}

	private addAction(recordingPath: string): void {
		if (!this.activeView || !this.activeSession) return;

		const session = this.activeSession;
		this.activeActionEl = this.activeView.addAction(
			"languages",
			"Transcribe recording",
			() => {
				const state = this.transcriptionManager.getState();
				if (state.status !== "idle") return;

				const request: TranscriptionRequest = {
					recordingPath,
					session: {
						eventId: session.eventId,
						subject: session.subject,
						date: session.date,
					},
				};
				void this.transcriptionManager.transcribe(request);
			},
		);
		this.activeActionEl.addClass("whisper-cal-note-transcribe-action");
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

		const state = this.transcriptionManager.getState();
		const activeStatuses = ["uploading", "transcribing", "polling", "saving"] as const;
		const isActive = activeStatuses.some(s => s === state.status);
		const isThisNote =
			isActive &&
			"request" in state &&
			state.request.session.eventId === this.activeSession.eventId;
		const isBusy = isActive && !isThisNote;

		this.activeActionEl.removeClass("whisper-cal-note-transcribe-active");
		this.activeActionEl.removeClass("whisper-cal-note-transcribe-disabled");

		if (isThisNote) {
			this.activeActionEl.addClass("whisper-cal-note-transcribe-active");
			this.activeActionEl.ariaLabel = "Transcription in progress";
		} else if (isBusy) {
			this.activeActionEl.addClass("whisper-cal-note-transcribe-disabled");
			this.activeActionEl.ariaLabel = "Another transcription in progress";
		} else {
			this.activeActionEl.ariaLabel = "Transcribe recording";
		}
	}
}
