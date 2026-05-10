import type {TFile} from "obsidian";

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
}

export type CardStatusVariant = "progress" | "recording" | "done" | "warning";

export interface CardStatus {
	message: string;
	icon?: string;
	variant?: CardStatusVariant;
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
	private readonly expanded = new Set<string>();
	private readonly startTimes = new Map<string, number>();
	private readonly durationTimers = new Map<string, ReturnType<typeof setInterval>>();

	// --- recordings ---
	getRecording(notePath: string): RecordingInfo | undefined { return this.recordings.get(notePath); }
	setRecording(notePath: string, info: RecordingInfo): void { this.recordings.set(notePath, info); }
	deleteRecording(notePath: string): void { this.recordings.delete(notePath); }
	hasRecording(notePath: string): boolean { return this.recordings.has(notePath); }
	get recordingCount(): number { return this.recordings.size; }
	forEachRecording(fn: (info: RecordingInfo, notePath: string) => void): void {
		this.recordings.forEach(fn);
	}

	// --- card status ---
	getStatus(notePath: string): CardStatus | undefined { return this.statuses.get(notePath); }
	setStatus(notePath: string, status: CardStatus): void { this.statuses.set(notePath, status); }
	deleteStatus(notePath: string): void { this.statuses.delete(notePath); }

	// --- expanded cards ---
	isExpanded(eventId: string): boolean { return this.expanded.has(eventId); }
	expand(eventId: string): void { this.expanded.add(eventId); }
	collapse(eventId: string): void { this.expanded.delete(eventId); }

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
		this.expanded.clear();
		this.startTimes.clear();
	}
}
