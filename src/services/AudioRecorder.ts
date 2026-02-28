export interface AudioRecorderConfig {
	systemAudioDeviceId?: string;
}

/**
 * Audio recording engine for Obsidian (Electron renderer).
 *
 * Strategy for system audio:
 * 1. If a device ID is configured (e.g. BlackHole), capture from it directly.
 * 2. Try getDisplayMedia (works if Obsidian ever adds a display media handler).
 * 3. Try getUserMedia with chromeMediaSource:'desktop' (legacy Electron path).
 * 4. Fall back to mic-only.
 *
 * When system audio is captured, it's merged with the mic stream via
 * Web Audio API. Otherwise records mic only.
 */
export class AudioRecorder {
	private streams: MediaStream[] = [];
	private audioContext: AudioContext | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private _hasSystemAudio = false;

	get hasSystemAudio(): boolean {
		return this._hasSystemAudio;
	}

	async start(config?: AudioRecorderConfig): Promise<void> {
		let systemStream: MediaStream | null = null;
		let micStream: MediaStream | null = null;

		// --- Attempt system audio capture ---
		if (config?.systemAudioDeviceId) {
			systemStream = await this.tryDeviceCapture(config.systemAudioDeviceId);
		}
		if (!systemStream) {
			systemStream = await this.tryGetDisplayMedia();
		}
		if (!systemStream) {
			systemStream = await this.tryDesktopCapturer();
		}

		if (systemStream) {
			this._hasSystemAudio = true;
			this.streams.push(systemStream);
			console.debug("[WhisperCal] System audio captured");
		} else {
			this._hasSystemAudio = false;
			console.debug("[WhisperCal] System audio unavailable, mic-only recording");
		}

		// --- Microphone ---
		try {
			micStream = await navigator.mediaDevices.getUserMedia({audio: true});
			this.streams.push(micStream);
			console.debug("[WhisperCal] Microphone captured");
		} catch (e) {
			this.releaseStreams();
			throw new Error(
				`Microphone access denied: ${e instanceof Error ? e.message : "unknown error"}`,
			);
		}

		// --- Build recording stream ---
		let recordingStream: MediaStream;

		if (systemStream && micStream) {
			// Merge system + mic via Web Audio API
			this.audioContext = new AudioContext();
			const sysSrc = this.audioContext.createMediaStreamSource(systemStream);
			const micSrc = this.audioContext.createMediaStreamSource(micStream);
			const merger = this.audioContext.createChannelMerger(2);
			sysSrc.connect(merger, 0, 0);
			micSrc.connect(merger, 0, 1);
			const dest = this.audioContext.createMediaStreamDestination();
			merger.connect(dest);
			recordingStream = dest.stream;
		} else {
			recordingStream = micStream;
		}

		// --- Choose mimeType ---
		const mimeType = this.pickMimeType();
		console.debug("[WhisperCal] MediaRecorder mimeType:", mimeType);

		// --- Record ---
		this.chunks = [];
		this.mediaRecorder = new MediaRecorder(recordingStream, {
			...(mimeType ? {mimeType} : {}),
		});
		this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
			if (e.data.size > 0) {
				this.chunks.push(e.data);
			}
		};
		this.mediaRecorder.start(1000);
	}

	pause(): void {
		if (this.mediaRecorder?.state === "recording") {
			this.mediaRecorder.pause();
		}
	}

	resume(): void {
		if (this.mediaRecorder?.state === "paused") {
			this.mediaRecorder.resume();
		}
	}

	async stop(): Promise<ArrayBuffer> {
		return new Promise<ArrayBuffer>((resolve, reject) => {
			if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
				reject(new Error("No active recording"));
				return;
			}

			this.mediaRecorder.onstop = () => {
				const mimeType = this.mediaRecorder?.mimeType ?? "audio/webm";
				const blob = new Blob(this.chunks, {type: mimeType});
				void blob.arrayBuffer().then(resolve, reject);
				this.releaseStreams();
			};
			this.mediaRecorder.onerror = () => {
				reject(new Error("MediaRecorder error during stop"));
				this.releaseStreams();
			};
			this.mediaRecorder.stop();
		});
	}

	get fileExtension(): string {
		const mime = this.mediaRecorder?.mimeType ?? "";
		if (mime.includes("webm")) return "webm";
		if (mime.includes("ogg")) return "ogg";
		if (mime.includes("mp4")) return "m4a";
		return "webm";
	}

	dispose(): void {
		if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
			try {
				this.mediaRecorder.stop();
			} catch {
				// Already stopped
			}
		}
		this.releaseStreams();
	}

	// --- Private helpers ---

	private async tryDeviceCapture(deviceId: string): Promise<MediaStream | null> {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {deviceId: {exact: deviceId}},
			});
			if (stream.getAudioTracks().length === 0) {
				return null;
			}
			console.debug("[WhisperCal] System audio device captured:", stream.getAudioTracks()[0]?.label);
			return stream;
		} catch (e) {
			console.debug("[WhisperCal] System audio device capture failed:", (e as Error).message);
			return null;
		}
	}

	private async tryGetDisplayMedia(): Promise<MediaStream | null> {
		try {
			const stream = await navigator.mediaDevices.getDisplayMedia({
				audio: true,
				video: true,
			});
			// Discard video tracks — we only need the audio
			for (const track of stream.getVideoTracks()) {
				track.stop();
				stream.removeTrack(track);
			}
			if (stream.getAudioTracks().length === 0) {
				return null;
			}
			return stream;
		} catch (e) {
			console.debug("[WhisperCal] getDisplayMedia unavailable:", (e as Error).message);
			return null;
		}
	}

	private async tryDesktopCapturer(): Promise<MediaStream | null> {
		try {
			// Electron legacy path: getUserMedia with chromeMediaSource constraint
			/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
			const constraints: MediaStreamConstraints = {
				audio: {
					chromeMediaSource: "desktop" as any,
				} as MediaTrackConstraints,
			};
			/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
			const stream = await navigator.mediaDevices.getUserMedia(constraints);
			if (stream.getAudioTracks().length === 0) {
				return null;
			}
			return stream;
		} catch (e) {
			console.debug("[WhisperCal] Desktop audio capture unavailable:", (e as Error).message);
			return null;
		}
	}

	private pickMimeType(): string | null {
		const candidates = [
			"audio/webm;codecs=opus",
			"audio/webm",
			"audio/ogg;codecs=opus",
			"audio/mp4",
		];
		for (const mime of candidates) {
			if (MediaRecorder.isTypeSupported(mime)) {
				return mime;
			}
		}
		return null; // Let the browser pick its default
	}

	private releaseStreams(): void {
		for (const stream of this.streams) {
			for (const track of stream.getTracks()) {
				track.stop();
			}
		}
		this.streams = [];
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
		}
		this.mediaRecorder = null;
		this.chunks = [];
	}
}
