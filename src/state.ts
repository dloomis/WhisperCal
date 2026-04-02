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
	/** Calendar event context for transcript enrichment. */
	meetingDate?: string;
	meetingStart?: string;
	meetingEnd?: string;
	organizer?: string;
	location?: string;
}

/** Active API recording: notePath → recording info. Only one recording at a time. */
export const recordingState = new Map<string, RecordingInfo>();

export type CardStatusVariant = "progress" | "recording" | "done" | "warning";

/** Transient status messages displayed on meeting cards, keyed by notePath. */
export const cardStatus = new Map<string, { message: string; icon?: string; variant?: CardStatusVariant }>();

/** Event IDs whose cards are currently expanded (not collapsed). Survives card rebuilds. */
export const expandedCards = new Set<string>();

/** Recording start timestamps (epoch ms), keyed by notePath. Set when recording begins. */
export const recordingStartTime = new Map<string, number>();
