/** Module-level shared state readable by any component. */

/** Note paths currently being summarized. */
export const summarizeJobs = new Set<string>();

/** Transcript paths currently being speaker-tagged. */
export const speakerTagJobs = new Set<string>();

/** Note paths currently running meeting research. */
export const researchJobs = new Set<string>();

export interface RecordingInfo {
	suggestedFilename: string;
	subject: string;
	attendees: string[];
	isRecurring: boolean;
	timezone: string;
	transcriptFolderPath: string;
}

/** Active API recording: notePath → recording info. Only one recording at a time. */
export const recordingState = new Map<string, RecordingInfo>();
