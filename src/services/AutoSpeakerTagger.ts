import {App, EventRef, TFile, TFolder} from "obsidian";
import type {WhisperCalSettings} from "../settings";
import type {JobTracker} from "./JobTracker";
import {FM} from "../constants";
import {readFmString, isSingleSourceTranscript, diarizedSpeakerCount} from "../utils/frontmatter";
import {resolveWikiLink, getMarkdownFilesRecursive} from "../utils/vault";
import {hasCachedProposals} from "./SpeakerTagParser";
import {transcriptBody, hasLiveLegLabels} from "../utils/transcript";
import {debug} from "../utils/debug";

/** Delay between a transcript becoming eligible and the auto-tag run, so
 * linkToNote's rename and note-side frontmatter writes can finish first. */
const SETTLE_MS = 10_000;
/** How often an automatic job re-checks for a free LLM slot while it waits.
 * Exported so the auto-summarize slot wait in main.ts retries on the same
 * cadence (and its countdown badge matches). */
export const LLM_SLOT_POLL_MS = 30_000;
/** Give up waiting for a slot after this long; the item is dropped without
 * being marked attempted, so a later frontmatter change re-arms it. */
export const LLM_SLOT_MAX_WAIT_MS = 30 * 60_000;
/** Delay after layout-ready before the startup catch-up scan runs. */
const CATCHUP_DELAY_MS = 10_000;

export interface AutoSpeakerTaggerDeps {
	app: App;
	getSettings: () => WhisperCalSettings;
	jobs: JobTracker;
	/** True when another LLM process can start (activeLlmCount < Core's maxConcurrent). */
	canStartLlm: () => boolean;
	/** LLM debug mode (opens a terminal) — owned by WhisperCore, read via
	 *  getLlmConfig(). Auto-tagging is skipped while it's on. */
	isLlmDebugMode: () => boolean;
	/** Kick off a background speaker-tagging run (doTagSpeakers with auto=true).
	 *  A returned promise lets the tagger un-mark the file on an unexpected crash. */
	runAutoTag: (file: TFile, fm: Record<string, unknown>, notePath: string) => void | Promise<void>;
	/** The queue head is waiting for a free LLM slot: called once per poll with
	 *  the epoch ms of the next re-check, so the meeting card can show a
	 *  countdown badge. */
	onSlotWait?: (notePath: string, retryAt: number) => void;
	/** The slot wait ended — "acquired" (a slot freed and the run starts),
	 *  "dropped" (gave up after the max wait), or "cancelled" (stop/new head).
	 *  Clears the countdown badge; "dropped" may add its own skipped notice. */
	onSlotWaitEnd?: (notePath: string, reason: "acquired" | "dropped" | "cancelled") => void;
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
	/** Meeting-note path whose card is showing the slot-wait countdown, so the
	 * badge can be cleared when the wait ends however it ends. */
	private slotWaitNotePath: string | null = null;

	constructor(private readonly deps: AutoSpeakerTaggerDeps) {}

	/** Register vault listeners and schedule the catch-up scan. Call from onLayoutReady. */
	start(): void {
		this.deps.registerEvent(
			this.deps.app.metadataCache.on("changed", (file: TFile) => {
				const folder = this.deps.getSettings().transcriptFolderPath;
				if (!folder || !file.path.startsWith(folder + "/")) return;
				void this.maybeEnqueue(file);
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
			void this.catchUpScan();
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
		this.endSlotWait("cancelled");
		this.cancelSleep();
	}

	/**
	 * Single eligibility predicate shared by the change listener, the catch-up
	 * scan, and the dequeue re-check. Async because the not-yet-finalized guard
	 * below reads the file body; callers that invoke a free LLM slot must await
	 * this BEFORE checking canStartLlm() so the slot-check-to-runAutoTag span
	 * stays free of awaits (see the comment in pump()).
	 */
	private async isEligible(file: TFile): Promise<EligibilityResult> {
		const s = this.deps.getSettings();
		const skip = (reason: string): {ok: false} => {
			debug("autoTag", `skip ${file.path}: ${reason}`);
			return {ok: false};
		};
		if (!s.autoSummarizeAfterTagging) return skip("automatic mode off");
		if (!s.llmEnabled) return skip("LLM features disabled");
		if (this.deps.isLlmDebugMode()) return skip("LLM debug mode on");
		if (!s.speakerTaggingPromptPath) return skip("no speaker tagging prompt");
		if (file.extension !== "md" || !s.transcriptFolderPath || !file.path.startsWith(s.transcriptFolderPath + "/")) {
			return skip("not a transcript file");
		}
		const fm = this.deps.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!fm || readFmString(fm, FM.PIPELINE_STATE) !== "titled") return skip("pipeline_state not titled");
		const noteFile = resolveWikiLink(this.deps.app, fm, FM.MEETING_NOTE, file.path);
		if (!noteFile) return skip("meeting_note link unresolved");
		// pipeline_state can be set to "titled" by a writer that ran before Tome's own
		// finalizer rewrote the body (the finalizer replaces its live-call-leg placeholder
		// labels with real diarized "Speaker N" names, 1-3 min after linking). Reading a
		// still-live body here would let buildMappingsFromBody cache a proposal keyed on
		// "Them" that Tome's finalizer can never retroactively fix. Defer WITHOUT touching
		// `attempted`, so the metadataCache "changed" event Tome's rewrite fires re-arms
		// this file the moment the body is actually ready.
		let content: string;
		try {
			content = await this.deps.app.vault.cachedRead(file);
		} catch (e) {
			return skip(`could not read transcript body: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (hasLiveLegLabels(transcriptBody(content))) {
			return skip("transcript not yet finalized — body still has a live 'Them' label");
		}
		// A single-source recording the diarizer collapsed to ≤1 speaker needs a manual hint
		// (how many people / who's who) that only the instructions modal carries — voiceprint
		// matching can't recover speakers diarization never separated, so leave those for a
		// manual click. But a voice memo the diarizer DID split into 2+ speakers is handled
		// acoustically like any meeting (voiceprint-first, no LLM), so let it auto-tag.
		if (isSingleSourceTranscript(fm) && diarizedSpeakerCount(fm) <= 1) {
			return skip("single-source transcript with <=1 diarized speaker");
		}
		if (hasCachedProposals(this.deps.app, file.path)) return skip("proposals already cached");
		if (this.deps.jobs.has("speakerTag", file.path)) return skip("tagging already running");
		if (this.attempted.has(file.path)) return skip("already attempted this session");
		return {ok: true, fm, notePath: noteFile.path};
	}

	private async maybeEnqueue(file: TFile): Promise<void> {
		if (this.stopped) return;
		if (this.queue.some(q => q.file === file)) return;
		if (!(await this.isEligible(file)).ok) return;
		this.queue.push({file, eligibleAt: Date.now() + SETTLE_MS});
		debug("autoTag", `enqueued ${file.path}`);
		void this.pump();
	}

	/**
	 * Single-consumer serial loop: settle, re-check eligibility (including the
	 * async not-yet-finalized body read), wait for an LLM slot, then invoke the
	 * run. The head is re-read after every sleep so queue mutations (deletes,
	 * stop) are picked up.
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
				// Re-check eligibility BEFORE the slot gate below (not after, as a
				// synchronous recheck would be) — isEligible awaits a vault read, and
				// the slot-check-to-runAutoTag span must stay free of awaits so a
				// concurrent manual tag run can't claim the slot in between (see
				// doTagSpeakers' matching comment on its own synchronous slot claim).
				const check = await this.isEligible(head.file);
				if (!check.ok) {
					// An in-wait head that went ineligible may still own the
					// countdown badge — clear it so a stale countdown can't leak.
					this.queue.shift();
					this.endSlotWait("cancelled");
					continue;
				}
				if (!this.deps.canStartLlm()) {
					if (Date.now() - head.eligibleAt > LLM_SLOT_MAX_WAIT_MS) {
						// Drop without marking attempted so a later frontmatter
						// change or the next startup scan re-arms it.
						this.queue.shift();
						this.endSlotWait("dropped");
						debug("autoTag", `slot wait timed out — dropping ${head.file.path}`);
						continue;
					}
					this.beginSlotWait(head.file);
					await this.sleep(LLM_SLOT_POLL_MS);
					continue;
				}
				this.endSlotWait("acquired");
				// Dequeue and invoke — no awaits between the slot check and
				// runAutoTag, so the free slot can't be raced away.
				this.queue.shift();
				// Mark before invoking: failed runs write nothing, so this is the
				// anti-loop marker; on success the cached proposals take over.
				this.attempted.add(head.file.path);
				debug("autoTag", `auto-tagging ${head.file.path}`);
				// An unexpected crash (rejection) un-marks the file so a later
				// frontmatter change or startup scan can retry it. A run that
				// completes without writing proposals stays marked — that is the
				// anti-loop behavior this set exists for.
				const path = head.file.path;
				void Promise.resolve(this.deps.runAutoTag(head.file, check.fm, check.notePath))
					.catch((e: unknown) => {
						debug("autoTag", `run crashed for ${path} — un-marking for retry: ${e instanceof Error ? e.message : String(e)}`);
						this.attempted.delete(path);
					});
			}
		} finally {
			this.pumping = false;
		}
	}

	/** Startup scan for transcripts that became ready while Obsidian was closed. */
	private async catchUpScan(): Promise<void> {
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
		// Sequential, not Promise.all: preserves ctime enqueue order (each maybeEnqueue
		// does an async body read, so parallel calls could otherwise race onto the queue).
		for (const f of candidates) {
			await this.maybeEnqueue(f);
		}
	}

	/** Point the slot-wait countdown badge at the head's meeting card. Called
	 * once per poll; re-firing just restarts the countdown. Skipped when the
	 * meeting-note link doesn't resolve (nowhere to show it). */
	private beginSlotWait(file: TFile): void {
		const fm = this.deps.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const noteFile = fm ? resolveWikiLink(this.deps.app, fm, FM.MEETING_NOTE, file.path) : null;
		if (!noteFile) return;
		// The waiting head changed (e.g. the old one was deleted mid-wait) —
		// clear the stale card's badge before pointing at the new one.
		if (this.slotWaitNotePath && this.slotWaitNotePath !== noteFile.path) {
			this.endSlotWait("cancelled");
		}
		this.slotWaitNotePath = noteFile.path;
		this.deps.onSlotWait?.(noteFile.path, Date.now() + LLM_SLOT_POLL_MS);
	}

	/** Clear the countdown badge if one is showing. Safe to call when not waiting. */
	private endSlotWait(reason: "acquired" | "dropped" | "cancelled"): void {
		if (!this.slotWaitNotePath) return;
		const notePath = this.slotWaitNotePath;
		this.slotWaitNotePath = null;
		this.deps.onSlotWaitEnd?.(notePath, reason);
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
