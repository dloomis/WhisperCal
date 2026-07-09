import type {TFile} from "obsidian";
import type {MeetingApp} from "../utils/meetingLink";

export interface RecordingInfo {
	/**
	 * Live reference to the meeting note. Obsidian updates TFile.path on rename,
	 * so this stays valid across renames during a long recording window — unlike
	 * the bare notePath string that keys recordings.
	 */
	noteFile: TFile | null;
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
	/**
	 * The desktop app WhisperCal launched for this meeting via auto-record-on-
	 * launch. Set only when we opened the app ourselves; when the recording is
	 * later stopped from WhisperCal, that app is quit to disconnect the user
	 * from the call. Absent for manually started recordings (nothing to close).
	 */
	launchedApp?: MeetingApp;
}

export type CardStatusVariant = "progress" | "recording" | "done" | "warning";

export interface CardStatus {
	message: string;
	icon?: string;
	variant?: CardStatusVariant;
	/** Compact gutter badge: activity light + one-word label, with the LLM
	 *  model name on a second line when the job runs on a model. Progress
	 *  labels are verbs ("Tagging", "Summarizing", "Matching"); result labels
	 *  are outcomes ("Linked", "Tagged", "Failed"). When set, the card renders
	 *  this in the gutter instead of the status message line; `message`
	 *  becomes the badge's tooltip. */
	badge?: {label: string; model?: string};
}

/**
 * Transient UI state for meeting cards: active recording, status messages,
 * expand/collapse state, recording start times, and per-note duration timers.
 *
 * Owned by the plugin instance. Cleared on plugin unload so timers are stopped
 * and stale UI state doesn't survive a reload.
 */
export class CardUiState {
	private readonly recordings = new Map<string, RecordingInfo>();
	private readonly statuses = new Map<string, CardStatus>();
	private readonly startTimes = new Map<string, number>();
	private readonly durationTimers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly recordingsChangeListeners = new Set<() => void>();

	// --- recordings ---
	getRecording(notePath: string): RecordingInfo | undefined { return this.recordings.get(notePath); }
	setRecording(notePath: string, info: RecordingInfo): void {
		this.recordings.set(notePath, info);
		this.notifyRecordingsChange();
	}
	deleteRecording(notePath: string): void {
		if (this.recordings.delete(notePath)) this.notifyRecordingsChange();
	}
	/**
	 * Record which desktop app WhisperCal launched for an in-progress recording,
	 * so stopping the recording from WhisperCal can close it. No-op (and no
	 * re-render) if the recording is gone — the app-close is a side effect, not
	 * render state.
	 */
	setRecordingLaunchedApp(notePath: string, app: MeetingApp): void {
		const info = this.recordings.get(notePath);
		if (info) info.launchedApp = app;
	}
	hasRecording(notePath: string): boolean {
		if (this.recordings.has(notePath)) return true;
		// The map key is the note path at recording start; if the note was renamed
		// mid-recording, match via the live TFile reference instead (path updates
		// on rename). The map is tiny, so the scan is cheap.
		for (const info of this.recordings.values()) {
			if (info.noteFile?.path === notePath) return true;
		}
		return false;
	}
	get recordingCount(): number { return this.recordings.size; }
	forEachRecording(fn: (info: RecordingInfo, notePath: string) => void): void {
		this.recordings.forEach(fn);
	}

	/**
	 * Subscribe to recordings-map mutations. Whether *any* capture is active is
	 * the sole input to every card's record-pill lock (computePillStates), so the
	 * one place that owns the mutation is the right place to fan out a re-render —
	 * callers no longer hand-place a notify after each start/stop. Returns an
	 * unsubscribe fn.
	 */
	onRecordingsChange(fn: () => void): () => void {
		this.recordingsChangeListeners.add(fn);
		return () => this.recordingsChangeListeners.delete(fn);
	}

	private notifyRecordingsChange(): void {
		this.recordingsChangeListeners.forEach(fn => fn());
	}

	// --- card status ---
	getStatus(notePath: string): CardStatus | undefined { return this.statuses.get(notePath); }
	setStatus(notePath: string, status: CardStatus): void { this.statuses.set(notePath, status); }
	deleteStatus(notePath: string): void { this.statuses.delete(notePath); }

	// --- recording start times ---
	getStartTime(notePath: string): number | undefined { return this.startTimes.get(notePath); }
	setStartTime(notePath: string, ms: number): void { this.startTimes.set(notePath, ms); }
	deleteStartTime(notePath: string): void { this.startTimes.delete(notePath); }

	// --- duration timers ---
	startDurationTimer(notePath: string, tick: () => void, intervalMs = 1000): void {
		this.stopDurationTimer(notePath);
		this.durationTimers.set(notePath, setInterval(tick, intervalMs));
	}

	stopDurationTimer(notePath: string): void {
		const id = this.durationTimers.get(notePath);
		if (id != null) {
			clearInterval(id);
			this.durationTimers.delete(notePath);
		}
	}

	stopAllDurationTimers(): void {
		for (const id of this.durationTimers.values()) clearInterval(id);
		this.durationTimers.clear();
	}

	/** Clear all card UI state. Stops outstanding timers. */
	clear(): void {
		this.stopAllDurationTimers();
		this.recordings.clear();
		this.statuses.clear();
		this.startTimes.clear();
	}
}
