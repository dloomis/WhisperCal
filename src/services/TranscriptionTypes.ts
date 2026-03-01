export interface TranscriptionRequest {
	recordingPath: string;
	session: {
		eventId: string;
		subject: string;
		date: string;
	};
}

export type TranscriptionState =
	| { status: "idle" }
	| { status: "uploading"; request: TranscriptionRequest }
	| { status: "transcribing"; request: TranscriptionRequest }
	| { status: "polling"; request: TranscriptionRequest; pollingStatus: "queued" | "processing"; audioDuration?: number }
	| { status: "saving"; request: TranscriptionRequest }
	| { status: "error"; message: string };

export type TranscriptionSavedCallback = (request: TranscriptionRequest, transcriptPath: string) => void;

export interface AssemblyAIUtterance {
	speaker: string;
	text: string;
	start: number;
	end: number;
}

export interface AssemblyAITranscriptResponse {
	id: string;
	status: string;
	error?: string;
	audio_duration?: number;
	utterances?: AssemblyAIUtterance[];
}
