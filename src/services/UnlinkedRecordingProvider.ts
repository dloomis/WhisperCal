import type {App} from "obsidian";
import type {EventAttendee} from "../types";

/**
 * Provider-agnostic shape for an unlinked recording displayed in CalendarView.
 * Each provider maps its internal data to this common shape.
 */
export interface UnlinkedRecording {
	/** Stable unique ID — MacWhisper session hex ID, API transcript file path, etc. */
	id: string;
	title: string;
	recordingStart: Date;
	durationSeconds: number;
	speakerCount: number;
	/** Opaque provider-specific payload. Providers cast this back in linkToNote(). */
	providerData: unknown;
}

export interface LinkUnlinkedOpts {
	app: App;
	recording: UnlinkedRecording;
	notePath: string;
	subject: string;
	timezone: string;
	transcriptFolderPath: string;
	attendees?: EventAttendee[];
	isRecurring?: boolean;
}

/**
 * Provider-agnostic interface for the unlinked recordings feature.
 * Implementations wrap provider-specific discovery and linking logic.
 */
export interface UnlinkedRecordingProvider {
	/** Human-readable name for UI strings, e.g. "MacWhisper", "Recording API". */
	readonly displayName: string;

	/** Fetch unlinked recordings within the lookback window. */
	findUnlinked(lookbackDays: number): Promise<UnlinkedRecording[]>;

	/** Link a recording to a meeting note. Provider handles all specifics. */
	linkToNote(opts: LinkUnlinkedOpts): Promise<boolean>;

	/**
	 * Test whether a note's frontmatter indicates it already has a recording
	 * linked via THIS provider. Used to filter event candidates.
	 */
	isNoteLinked(fm: Record<string, unknown>): boolean;
}
