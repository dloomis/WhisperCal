import {App, EventRef, TFile, TFolder} from "obsidian";
import type {WhisperCalSettings} from "../settings";
import type {JobTracker} from "./JobTracker";
import {FM} from "../constants";
import {readFmString, isSingleSourceTranscript} from "../utils/frontmatter";
import {resolveWikiLink, getMarkdownFilesRecursive} from "../utils/vault";
import {hasCachedProposals} from "./SpeakerTagParser";
import {debug} from "../utils/debug";

/** Delay between a transcript becoming eligible and the auto-tag run, so
 * linkToNote's rename and note-side frontmatter writes can finish first. */
const SETTLE_MS = 10_000;
/** How often to re-check for a free LLM slot while the queue head waits. */
const SLOT_POLL_MS = 30_000;
/** Give up waiting for a slot after this long; the item is dropped without
 * being marked attempted, so a later frontmatter change re-arms it. */
const MAX_SLOT_WAIT_MS = 30 * 60_000;
/** Delay after layout-ready before the startup catch-up scan runs. */
const CATCHUP_DELAY_MS = 10_000;

export interface AutoSpeakerTaggerDeps {
	app: App;
	getSettings: () => WhisperCalSettings;
	jobs: JobTracker;
	/** True when another LLM process can start (activeLlmCount < llmMaxConcurrent). */
	canStartLlm: () => boolean;
	/** Kick off a background speaker-tagging run (doTagSpeakers with auto=true). */
	runAutoTag: (file: TFile, fm: Record<string, unknown>, notePath: string) => void;
	/** plugin.registerEvent — ties listener lifetime to the plugin. */
	registerEvent: (ref: EventRef) => void;
}

type EligibilityResult =
	| {ok: true; fm: Record<string, unknown>; notePath: string}
	| {ok: false};

/**
 * Watches the transcript folder and automatically runs the existing
 * speaker-tagging LLM job in the background when a transcript becomes ready
 * (pipeline_state "titled", linked to a meeting note). The run stops after
 * caching proposals to frontmatter — tags are never applied without the user
 * reviewing them via the Speakers pill.
 */
export class AutoSpeakerTagger {
	/** FIFO of pending transcripts. Holds live TFiles so paths survive renames. */
	private queue: {file: TFile; eligibleAt: number}[] = [];
	/** Session-scoped loop guard for runs that wrote nothing (failures, zero
	 * mappings). Successful runs are blocked durably by their cached proposals. */
	private readonly attempted = new Set<string>();
	private pumping = false;
	private stopped = false;
	private catchupTimer: ReturnType<typeof setTimeout> | null = null;
	private sleepTimer: ReturnType<typeof setTimeout> | null = null;
	private sleepResolve: (() => void) | null = null;

	constructor(private readonly deps: AutoSpeakerTaggerDeps) {}

	/** Register vault listeners and schedule the catch-up scan. Call from onLayoutReady. */
	start(): void {
		this.deps.registerEvent(
			this.deps.app.metadataCache.on("changed", (file: TFile) => {
				const folder = this.deps.getSettings().transcriptFolderPath;
				if (!folder || !file.path.startsWith(folder + "/")) return;
				this.maybeEnqueue(file);
			}),
		);
		// A deleted transcript re-arms re-recording: clear its loop guard
		this.deps.registerEvent(
			this.deps.app.vault.on("delete", (file) => {
				this.attempted.delete(file.path);
				this.queue = this.queue.filter(q => q.file !== file);
			}),
		);
		this.deps.registerEvent(
			this.deps.app.vault.on("rename", (_file, oldPath) => {
				this.attempted.delete(oldPath);
			}),
		);
		this.catchupTimer = setTimeout(() => {
			this.catchupTimer = null;
			this.catchUpScan();
		}, CATCHUP_DELAY_MS);
	}

	/** Halt the queue and cancel timers. Listeners die via plugin.registerEvent. */
	stop(): void {
		this.stopped = true;
		this.queue = [];
		if (this.catchupTimer) {
			clearTimeout(this.catchupTimer);
			this.catchupTimer = null;
		}
		this.cancelSleep();
	}

	/**
	 * Single eligibility predicate shared by the change listener, the catch-up
	 * scan, and the dequeue re-check.
	 */
	private isEligible(file: TFile): EligibilityResult {
		const s = this.deps.getSettings();
		const skip = (reason: string): {ok: false} => {
			debug("autoTag", `skip ${file.path}: ${reason}`);
			return {ok: false};
		};
		if (!s.autoSummarizeAfterTagging) return skip("automatic mode off");
		if (!s.llmEnabled) return skip("LLM features disabled");
		if (s.llmDebugMode) return skip("LLM debug mode on");
		if (!s.speakerTaggingPromptPath) return skip("no speaker tagging prompt");
		if (file.extension !== "md" || !s.transcriptFolderPath || !file.path.startsWith(s.transcriptFolderPath + "/")) {
			return skip("not a transcript file");
		}
		const fm = this.deps.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!fm || readFmString(fm, FM.PIPELINE_STATE) !== "titled") return skip("pipeline_state not titled");
		const noteFile = resolveWikiLink(this.deps.app, fm, FM.MEETING_NOTE, file.path);
		if (!noteFile) return skip("meeting_note link unresolved");
		// Single-source recordings need manual hints via the instructions modal
		if (isSingleSourceTranscript(fm)) return skip("single-source transcript");
		if (hasCachedProposals(this.deps.app, file.path)) return skip("proposals already cached");
		if (this.deps.jobs.has("speakerTag", file.path)) return skip("tagging already running");
		if (this.attempted.has(file.path)) return skip("already attempted this session");
		return {ok: true, fm, notePath: noteFile.path};
	}

	private maybeEnqueue(file: TFile): void {
		if (this.stopped) return;
		if (this.queue.some(q => q.file === file)) return;
		if (!this.isEligible(file).ok) return;
		this.queue.push({file, eligibleAt: Date.now() + SETTLE_MS});
		debug("autoTag", `enqueued ${file.path}`);
		void this.pump();
	}

	/**
	 * Single-consumer serial loop: settle, wait for an LLM slot, re-check
	 * eligibility at dequeue, then invoke the run. The head is re-read after
	 * every sleep so queue mutations (deletes, stop) are picked up.
	 */
	private async pump(): Promise<void> {
		if (this.pumping || this.stopped) return;
		this.pumping = true;
		try {
			while (!this.stopped && this.queue.length > 0) {
				const head = this.queue[0]!;
				const settleWait = head.eligibleAt - Date.now();
				if (settleWait > 0) {
					await this.sleep(settleWait);
					continue;
				}
				if (!this.deps.canStartLlm()) {
					if (Date.now() - head.eligibleAt > MAX_SLOT_WAIT_MS) {
						// Drop without marking attempted so a later frontmatter
						// change or the next startup scan re-arms it.
						this.queue.shift();
						debug("autoTag", `slot wait timed out — dropping ${head.file.path}`);
						continue;
					}
					await this.sleep(SLOT_POLL_MS);
					continue;
				}
				// Dequeue and re-check synchronously — no awaits between the slot
				// check and runAutoTag, so the free slot can't be raced away.
				this.queue.shift();
				const check = this.isEligible(head.file);
				if (!check.ok) continue;
				// Mark before invoking: failed runs write nothing, so this is the
				// anti-loop marker; on success the cached proposals take over.
				this.attempted.add(head.file.path);
				debug("autoTag", `auto-tagging ${head.file.path}`);
				this.deps.runAutoTag(head.file, check.fm, check.notePath);
			}
		} finally {
			this.pumping = false;
		}
	}

	/** Startup scan for transcripts that became ready while Obsidian was closed. */
	private catchUpScan(): void {
		if (this.stopped) return;
		const s = this.deps.getSettings();
		if (!s.autoSummarizeAfterTagging || s.autoTagLookbackHours <= 0) return;
		const folder = this.deps.app.vault.getAbstractFileByPath(s.transcriptFolderPath);
		if (!(folder instanceof TFolder)) return;
		const cutoff = Date.now() - s.autoTagLookbackHours * 3_600_000;
		const candidates = getMarkdownFilesRecursive(folder)
			.filter(f => f.stat.ctime >= cutoff)
			.sort((a, b) => a.stat.ctime - b.stat.ctime);
		debug("autoTag", `catch-up scan: ${candidates.length} transcript(s) within ${s.autoTagLookbackHours}h`);
		for (const f of candidates) {
			this.maybeEnqueue(f);
		}
	}

	/** Cancellable sleep — stop() resolves it immediately. Single-consumer, so
	 * at most one sleep is parked at a time. */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.sleepResolve = resolve;
			this.sleepTimer = setTimeout(() => {
				this.sleepTimer = null;
				this.sleepResolve = null;
				resolve();
			}, ms);
		});
	}

	private cancelSleep(): void {
		if (this.sleepTimer) {
			clearTimeout(this.sleepTimer);
			this.sleepTimer = null;
		}
		if (this.sleepResolve) {
			this.sleepResolve();
			this.sleepResolve = null;
		}
	}
}
