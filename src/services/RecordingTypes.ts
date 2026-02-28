export interface RecordingSession {
	eventId: string;
	subject: string;
	date: string;
}

export type RecordingSessionState =
	| { status: "idle" }
	| { status: "recording"; session: RecordingSession; startedAt: number; pausedDuration: number }
	| { status: "paused"; session: RecordingSession; startedAt: number; pausedDuration: number; pausedAt: number }
	| { status: "saving"; session: RecordingSession }
	| { status: "error"; message: string };
