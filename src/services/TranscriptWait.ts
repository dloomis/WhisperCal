import type {TFile} from "obsidian";

export interface TranscriptWaitDeps {
	/** Look for a finalized transcript right now; null while none is ready. */
	findReady: () => Promise<TFile | null>;
	/** Subscribe to change events that could make a transcript ready (metadataCache
	 * "changed" scoped to the transcript folder). Returns the unsubscribe function. */
	subscribeChanges: (onChange: () => void) => () => void;
	/** Plugin-lifecycle stop signal — true means resolve null and release everything. */
	isStopped: () => boolean;
	/** Wall-clock cap on the whole wait; resolves null once exceeded. */
	timeoutMs: number;
	/** Belt-and-braces periodic recheck, so a missed event, the stop signal, or the
	 * deadline is noticed without a change event. */
	recheckIntervalMs: number;
}

export interface TranscriptWaitHandle {
	/** Resolves with the finalized transcript, or null on timeout/stop/cancel. */
	promise: Promise<TFile | null>;
	/** Resolve null now and release the listener/timer (plugin unload). */
	cancel: () => void;
}

/**
 * Wait for a finalized transcript, event-driven rather than budgeted: re-arm on every
 * change event (Tome's export and its later rewrites fire metadataCache "changed")
 * instead of giving up after a fixed number of polls. The recording service's
 * post-processing can land the final export minutes after capture ends, which is
 * exactly the window a fixed poll budget kept missing.
 */
export function waitForFinalizedTranscript(deps: TranscriptWaitDeps): TranscriptWaitHandle {
	const deadline = Date.now() + deps.timeoutMs;
	let done = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let unsubscribe: (() => void) | null = null;
	// Coalesce overlapping rechecks: an event storm marks a rerun instead of racing
	// concurrent findReady reads; the in-flight run loops until no rerun is pending.
	let inFlight = false;
	let rerunRequested = false;

	let settle: (file: TFile | null) => void = () => {};
	const promise = new Promise<TFile | null>((resolve) => {
		settle = (file) => {
			if (done) return;
			done = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			unsubscribe?.();
			unsubscribe = null;
			resolve(file);
		};
	});

	const recheck = async (): Promise<void> => {
		if (done) return;
		if (inFlight) {
			rerunRequested = true;
			return;
		}
		inFlight = true;
		try {
			do {
				rerunRequested = false;
				if (deps.isStopped()) {
					settle(null);
					return;
				}
				const file = await deps.findReady();
				if (done) return;
				if (file) {
					settle(file);
					return;
				}
				if (Date.now() >= deadline) {
					settle(null);
					return;
				}
			} while (rerunRequested);
		} finally {
			inFlight = false;
		}
	};

	const tick = (): void => {
		timer = setTimeout(() => {
			timer = null;
			void recheck().then(() => {
				if (!done) tick();
			});
		}, deps.recheckIntervalMs);
	};

	// Arm the listener BEFORE the initial check so a change landing in between
	// can't be missed; the belt timer would catch it anyway, but slowly.
	unsubscribe = deps.subscribeChanges(() => {
		void recheck();
	});
	void recheck().then(() => {
		if (!done) tick();
	});

	return {promise, cancel: () => settle(null)};
}
