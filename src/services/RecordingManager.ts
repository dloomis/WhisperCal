import type {App} from "obsidian";
import {Notice, normalizePath} from "obsidian";
import {AudioRecorder} from "./AudioRecorder";
import type {RecordingSession, RecordingSessionState} from "./RecordingTypes";
import {sanitizeFilename} from "../utils/sanitize";

export interface RecordingConfig {
	recordingFolderPath: string;
	systemAudioDeviceId: string;
}

export class RecordingManager {
	private app: App;
	private config: RecordingConfig;
	private recorder: AudioRecorder | null = null;
	private state: RecordingSessionState = {status: "idle"};
	private listeners: Array<(state: RecordingSessionState) => void> = [];

	constructor(app: App, config: RecordingConfig) {
		this.app = app;
		this.config = config;
	}

	getState(): RecordingSessionState {
		return this.state;
	}

	updateConfig(config: RecordingConfig): void {
		this.config = config;
	}

	onChange(listener: (state: RecordingSessionState) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter(l => l !== listener);
		};
	}

	async startRecording(session: RecordingSession): Promise<void> {
		if (this.state.status === "recording" || this.state.status === "paused") {
			new Notice("A recording is already in progress");
			return;
		}

		try {
			this.recorder = new AudioRecorder();
			await this.recorder.start({
				systemAudioDeviceId: this.config.systemAudioDeviceId || undefined,
			});
			if (!this.recorder.hasSystemAudio) {
				new Notice("System audio unavailable — recording microphone only");
			}
			this.setState({
				status: "recording",
				session,
				startedAt: Date.now(),
				pausedDuration: 0,
			});
		} catch (e) {
			console.error("[WhisperCal] Recording start failed:", e);
			this.recorder?.dispose();
			this.recorder = null;
			const message = e instanceof Error ? e.message : "Failed to start recording";
			this.setState({status: "error", message});
		}
	}

	pauseRecording(): void {
		if (this.state.status !== "recording" || !this.recorder) return;
		this.recorder.pause();
		this.setState({
			status: "paused",
			session: this.state.session,
			startedAt: this.state.startedAt,
			pausedDuration: this.state.pausedDuration,
			pausedAt: Date.now(),
		});
	}

	resumeRecording(): void {
		if (this.state.status !== "paused" || !this.recorder) return;
		this.recorder.resume();
		const additionalPause = Date.now() - this.state.pausedAt;
		this.setState({
			status: "recording",
			session: this.state.session,
			startedAt: this.state.startedAt,
			pausedDuration: this.state.pausedDuration + additionalPause,
		});
	}

	async stopRecording(): Promise<void> {
		if (
			(this.state.status !== "recording" && this.state.status !== "paused") ||
			!this.recorder
		) {
			return;
		}

		const session = this.state.session;
		const ext = this.recorder.fileExtension;
		this.setState({status: "saving", session});

		try {
			const buffer = await this.recorder.stop();
			this.recorder = null;
			await this.saveRecording(buffer, session, ext);
			this.setState({status: "idle"});
			new Notice("Recording saved");
		} catch (e) {
			this.recorder?.dispose();
			this.recorder = null;
			const message = e instanceof Error ? e.message : "Failed to save recording";
			this.setState({status: "error", message});
		}
	}

	dismissError(): void {
		if (this.state.status === "error") {
			this.setState({status: "idle"});
		}
	}

	dispose(): void {
		if (this.recorder) {
			this.recorder.dispose();
			this.recorder = null;
		}
		this.setState({status: "idle"});
		this.listeners = [];
	}

	private setState(state: RecordingSessionState): void {
		this.state = state;
		for (const listener of this.listeners) {
			listener(state);
		}
	}

	private async saveRecording(buffer: ArrayBuffer, session: RecordingSession, ext: string): Promise<void> {
		const folder = this.config.recordingFolderPath || "Recordings";
		await this.ensureFolder(folder);

		const baseName = sanitizeFilename(`${session.date} - ${session.subject}`);
		const filePath = await this.uniquePath(folder, baseName, ext);

		await this.app.vault.createBinary(filePath, buffer);
	}

	private async uniquePath(folder: string, baseName: string, ext: string): Promise<string> {
		const candidate = normalizePath(`${folder}/${baseName}.${ext}`);
		if (!this.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}

		let n = 2;
		while (true) {
			const path = normalizePath(`${folder}/${baseName} (${n}).${ext}`);
			if (!this.app.vault.getAbstractFileByPath(path)) {
				return path;
			}
			n++;
		}
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing) return;

		try {
			await this.app.vault.createFolder(normalized);
		} catch {
			// Race condition: folder was created between check and create
			if (!this.app.vault.getAbstractFileByPath(normalized)) {
				throw new Error(`Could not create folder: ${normalized}`);
			}
		}
	}
}
