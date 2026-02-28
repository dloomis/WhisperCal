import type {App} from "obsidian";
import {Notice, normalizePath, requestUrl} from "obsidian";
import {TFile} from "obsidian";
import {buildMultipartBody, audioMimeType} from "../utils/multipart";
import {sanitizeFilename} from "../utils/sanitize";
import type {
	TranscriptionRequest,
	TranscriptionState,
	TranscriptionSavedCallback,
	WhisperVerboseResponse,
	WhisperSegment,
} from "./TranscriptionTypes";

export interface TranscriptionConfig {
	transcriptionFolderPath: string;
	transcriptionServerUrl: string;
	transcriptionModel: string;
	transcriptionLanguage: string;
}

export class TranscriptionManager {
	private app: App;
	private config: TranscriptionConfig;
	private state: TranscriptionState = {status: "idle"};
	private listeners: Array<(state: TranscriptionState) => void> = [];
	private savedListeners: Array<TranscriptionSavedCallback> = [];

	constructor(app: App, config: TranscriptionConfig) {
		this.app = app;
		this.config = config;
	}

	getState(): TranscriptionState {
		return this.state;
	}

	updateConfig(config: TranscriptionConfig): void {
		this.config = config;
	}

	onChange(listener: (state: TranscriptionState) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter(l => l !== listener);
		};
	}

	onTranscriptionSaved(listener: TranscriptionSavedCallback): () => void {
		this.savedListeners.push(listener);
		return () => {
			this.savedListeners = this.savedListeners.filter(l => l !== listener);
		};
	}

	async transcribe(request: TranscriptionRequest): Promise<void> {
		if (this.state.status !== "idle") {
			new Notice("A transcription is already in progress");
			return;
		}

		this.setState({status: "transcribing", request});

		try {
			const audioBuffer = await this.readAudioFile(request.recordingPath);
			const response = await this.postToServer(audioBuffer, request.recordingPath);
			const segments = this.parseResponse(response);
			const markdown = this.formatTranscript(segments);

			this.setState({status: "saving", request});
			const savedPath = await this.saveTranscript(markdown, request);

			this.setState({status: "idle"});
			new Notice("Transcription saved");

			for (const listener of this.savedListeners) {
				listener(request, savedPath);
			}
		} catch (e) {
			console.error("[WhisperCal] Transcription failed:", e);
			const message = e instanceof Error ? e.message : "Transcription failed";
			new Notice(`Transcription failed: ${message}`);
			this.setState({status: "error", message});

			// Auto-recover to idle after a short delay
			window.setTimeout(() => {
				if (this.state.status === "error") {
					this.setState({status: "idle"});
				}
			}, 3000);
		}
	}

	dispose(): void {
		this.setState({status: "idle"});
		this.listeners = [];
		this.savedListeners = [];
	}

	private setState(state: TranscriptionState): void {
		this.state = state;
		for (const listener of this.listeners) {
			listener(state);
		}
	}

	private async readAudioFile(recordingPath: string): Promise<ArrayBuffer> {
		const file = this.app.vault.getAbstractFileByPath(recordingPath);
		if (!(file instanceof TFile)) {
			throw new Error(`Recording file not found: ${recordingPath}`);
		}
		return await this.app.vault.readBinary(file);
	}

	private async postToServer(audioBuffer: ArrayBuffer, recordingPath: string): Promise<WhisperVerboseResponse> {
		const url = this.config.transcriptionServerUrl.replace(/\/+$/, "");
		const filename = recordingPath.split("/").pop() ?? "audio.webm";
		const ext = filename.split(".").pop() ?? "webm";

		const fields = [
			{name: "model", value: this.config.transcriptionModel || "large-v3-turbo"},
			{name: "response_format", value: "verbose_json"},
		];

		if (this.config.transcriptionLanguage) {
			fields.push({name: "language", value: this.config.transcriptionLanguage});
		}

		const {body, contentType} = buildMultipartBody(fields, {
			name: "file",
			filename,
			mimeType: audioMimeType(ext),
			data: audioBuffer,
		});

		const response = await requestUrl({
			url: `${url}/v1/audio/transcriptions`,
			method: "POST",
			headers: {"Content-Type": contentType},
			body,
		});

		return response.json as WhisperVerboseResponse;
	}

	private parseResponse(response: WhisperVerboseResponse): WhisperSegment[] {
		if (!response.segments || !Array.isArray(response.segments)) {
			throw new Error("Server response missing segments array");
		}

		const hasSpeakers = response.segments.length > 0 &&
			response.segments.some(s => s.speaker !== undefined && s.speaker !== null);

		if (!hasSpeakers) {
			throw new Error("Server response missing speaker labels — diarization is required");
		}

		return response.segments;
	}

	private formatTranscript(segments: WhisperSegment[]): string {
		const lines: string[] = [];
		let lastSpeaker = "";
		let blockStart = 0;
		let blockTexts: string[] = [];

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i] as WhisperSegment;
			const speaker = seg.speaker ?? "Unknown";

			if (speaker !== lastSpeaker) {
				// Flush previous block
				if (blockTexts.length > 0) {
					const prev = segments[i - 1] as WhisperSegment;
					lines.push(`**${lastSpeaker}** (${this.formatTimestamp(blockStart)} - ${this.formatTimestamp(prev.end)})`);
					lines.push(blockTexts.join(" ").trim());
					lines.push("");
				}
				lastSpeaker = speaker;
				blockStart = seg.start;
				blockTexts = [seg.text.trim()];
			} else {
				blockTexts.push(seg.text.trim());
			}
		}

		// Flush final block
		if (blockTexts.length > 0) {
			const lastSeg = segments[segments.length - 1] as WhisperSegment;
			lines.push(`**${lastSpeaker}** (${this.formatTimestamp(blockStart)} - ${this.formatTimestamp(lastSeg.end)})`);
			lines.push(blockTexts.join(" ").trim());
			lines.push("");
		}

		return lines.join("\n");
	}

	private formatTimestamp(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${String(secs).padStart(2, "0")}`;
	}

	private async saveTranscript(markdown: string, request: TranscriptionRequest): Promise<string> {
		const folder = this.config.transcriptionFolderPath || "Transcriptions";
		await this.ensureFolder(folder);

		const baseName = sanitizeFilename(`${request.session.date} - ${request.session.subject}`);
		const filePath = await this.uniquePath(folder, baseName, "md");

		await this.app.vault.create(filePath, markdown);
		return filePath;
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
			if (!this.app.vault.getAbstractFileByPath(normalized)) {
				throw new Error(`Could not create folder: ${normalized}`);
			}
		}
	}
}
