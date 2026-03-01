import type {App} from "obsidian";
import {Notice, normalizePath} from "obsidian";
import {TFile} from "obsidian";
import {sanitizeFilename} from "../utils/sanitize";
import type {
	TranscriptionRequest,
	TranscriptionState,
	TranscriptionSavedCallback,
	AssemblyAITranscriptResponse,
	AssemblyAIUtterance,
} from "./TranscriptionTypes";

const POLL_INTERVAL_MS = 3000;

export interface TranscriptionConfig {
	transcriptionFolderPath: string;
	assemblyAiBaseUrl: string;
	assemblyAiApiKey: string;
	assemblyAiSpeechModel: string;
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

	private get baseUrl(): string {
		return this.config.assemblyAiBaseUrl.replace(/\/+$/, "");
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

		try {
			this.setState({status: "uploading", request});
			const audioBuffer = await this.readAudioFile(request.recordingPath);
			const uploadUrl = await this.uploadAudio(audioBuffer);

			this.setState({status: "transcribing", request});
			const transcriptId = await this.submitTranscription(uploadUrl);

			this.setState({status: "polling", request, pollingStatus: "queued"});
			const response = await this.pollTranscription(transcriptId, request);

			const utterances = this.parseResponse(response);
			const markdown = this.formatTranscript(utterances);

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

	/* eslint-disable no-restricted-globals */

	/** Fetch wrapper that reads error response bodies for diagnostics. */
	private async apiRequest(url: string, init: RequestInit): Promise<Response> {
		const response = await fetch(url, {
			...init,
			headers: {
				"Authorization": this.config.assemblyAiApiKey,
				...init.headers as Record<string, string>,
			},
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`status ${response.status}: ${body.substring(0, 300)}`);
		}

		return response;
	}

	/* eslint-enable no-restricted-globals */

	private async uploadAudio(audioBuffer: ArrayBuffer): Promise<string> {
		console.debug("[WhisperCal] Uploading audio to AssemblyAI", {size: audioBuffer.byteLength});

		let response;
		try {
			response = await this.apiRequest(`${this.baseUrl}/upload`, {
				method: "POST",
				headers: {"Content-Type": "application/octet-stream"},
				body: audioBuffer,
			});
		} catch (e) {
			throw new Error(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
		}

		const data = await response.json() as {upload_url?: string};
		if (!data.upload_url) {
			throw new Error("AssemblyAI upload did not return an upload_url");
		}

		console.debug("[WhisperCal] Audio uploaded:", data.upload_url);
		return data.upload_url;
	}

	private async submitTranscription(uploadUrl: string): Promise<string> {
		const body: Record<string, unknown> = {
			audio_url: uploadUrl,
			speech_models: [this.config.assemblyAiSpeechModel || "universal-3-pro"],
			speaker_labels: true,
		};

		if (this.config.transcriptionLanguage) {
			body["language_code"] = this.config.transcriptionLanguage;
		}

		console.debug("[WhisperCal] Submitting transcription:", body);

		let response;
		try {
			response = await this.apiRequest(`${this.baseUrl}/transcript`, {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify(body),
			});
		} catch (e) {
			throw new Error(`Submit failed: ${e instanceof Error ? e.message : String(e)}`);
		}

		const data = await response.json() as {id?: string};
		if (!data.id) {
			throw new Error("AssemblyAI did not return a transcript ID");
		}

		console.debug("[WhisperCal] Transcript submitted:", data.id);
		return data.id;
	}

	private async pollTranscription(transcriptId: string, request: TranscriptionRequest): Promise<AssemblyAITranscriptResponse> {
		const url = `${this.baseUrl}/transcript/${transcriptId}`;

		while (true) {
			let response;
			try {
				response = await this.apiRequest(url, {method: "GET"});
			} catch (e) {
				throw new Error(`Poll failed: ${e instanceof Error ? e.message : String(e)}`);
			}

			const data = await response.json() as AssemblyAITranscriptResponse;
			console.debug("[WhisperCal] Poll status:", data.status);

			if (data.status === "completed") {
				return data;
			}

			if (data.status === "error") {
				throw new Error(`Transcription error: ${data.error ?? "unknown"}`);
			}

			const pollingStatus = data.status === "processing" ? "processing" : "queued";
			this.setState({status: "polling", request, pollingStatus, audioDuration: data.audio_duration});

			await this.sleep(POLL_INTERVAL_MS);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => window.setTimeout(resolve, ms));
	}

	private parseResponse(response: AssemblyAITranscriptResponse): AssemblyAIUtterance[] {
		if (!response.utterances || !Array.isArray(response.utterances)) {
			throw new Error("AssemblyAI response missing utterances — speaker_labels may not be enabled");
		}

		return response.utterances;
	}

	private formatTranscript(utterances: AssemblyAIUtterance[]): string {
		const lines: string[] = [];

		for (const utterance of utterances) {
			const speaker = utterance.speaker ?? "Unknown";
			const startSec = utterance.start / 1000;
			const endSec = utterance.end / 1000;
			lines.push(`**Speaker ${speaker}** (${this.formatTimestamp(startSec)} - ${this.formatTimestamp(endSec)})`);
			lines.push(utterance.text.trim());
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
