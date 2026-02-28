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
	| { status: "transcribing"; request: TranscriptionRequest }
	| { status: "saving"; request: TranscriptionRequest }
	| { status: "error"; message: string };

export type TranscriptionSavedCallback = (request: TranscriptionRequest, transcriptPath: string) => void;

export interface WhisperSegment {
	start: number;
	end: number;
	text: string;
	speaker: string;
}

export interface WhisperVerboseResponse {
	text: string;
	segments: WhisperSegment[];
	duration: number;
	language: string;
}
