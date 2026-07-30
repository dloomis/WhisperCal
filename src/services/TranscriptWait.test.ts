import {test} from "node:test";
import assert from "node:assert/strict";
import type {TFile} from "obsidian";
import {waitForFinalizedTranscript, type TranscriptWaitDeps} from "./TranscriptWait";

// This repo's "obsidian" package is types-only (no runtime), so a minimal TFile is faked.
function fakeFile(path: string): TFile {
	// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
	return {path, extension: "md"} as unknown as TFile;
}

const TRANSCRIPT = fakeFile("Transcripts/Some Meeting - Transcript.md");

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Deps harness: readiness and stop are mutable knobs; subscription is observable. */
function makeDeps(overrides?: Partial<TranscriptWaitDeps>): {
	deps: TranscriptWaitDeps;
	state: {ready: TFile | null; stopped: boolean; subscribed: number; unsubscribed: number};
	fireChange: () => void;
} {
	const state = {ready: null as TFile | null, stopped: false, subscribed: 0, unsubscribed: 0};
	let listener: (() => void) | null = null;
	const deps: TranscriptWaitDeps = {
		findReady: async () => state.ready,
		subscribeChanges: (onChange) => {
			state.subscribed++;
			listener = onChange;
			return () => {
				state.unsubscribed++;
				listener = null;
			};
		},
		isStopped: () => state.stopped,
		timeoutMs: 2000,
		recheckIntervalMs: 500,
		...overrides,
	};
	return {deps, state, fireChange: () => listener?.()};
}

void test("resolves with the transcript when it is already ready", async () => {
	const {deps, state} = makeDeps();
	state.ready = TRANSCRIPT;
	const handle = waitForFinalizedTranscript(deps);
	assert.equal(await handle.promise, TRANSCRIPT);
	assert.equal(state.unsubscribed, state.subscribed); // nothing left armed
});

void test("stays pending until a change event makes the transcript ready", async () => {
	const {deps, state, fireChange} = makeDeps();
	const handle = waitForFinalizedTranscript(deps);

	let resolved: TFile | null | "pending" = "pending";
	void handle.promise.then((v) => { resolved = v; });
	await sleep(20);
	assert.equal(resolved, "pending"); // not ready, no event → still waiting
	assert.equal(state.subscribed, 1); // armed on the change feed

	state.ready = TRANSCRIPT;
	fireChange();
	assert.equal(await handle.promise, TRANSCRIPT);
	assert.equal(state.unsubscribed, 1);
});

void test("periodic recheck picks up readiness even without a change event", async () => {
	const {deps, state} = makeDeps({recheckIntervalMs: 15});
	const handle = waitForFinalizedTranscript(deps);
	await sleep(5);
	state.ready = TRANSCRIPT; // becomes ready silently — no event fired
	assert.equal(await handle.promise, TRANSCRIPT);
	assert.equal(state.unsubscribed, 1);
});

void test("resolves null once the timeout elapses and releases the listener", async () => {
	const {deps, state} = makeDeps({timeoutMs: 60, recheckIntervalMs: 15});
	const start = Date.now();
	const handle = waitForFinalizedTranscript(deps);
	assert.equal(await handle.promise, null);
	assert.ok(Date.now() - start >= 55, "gave up before the timeout elapsed");
	assert.equal(state.unsubscribed, 1);
});

void test("cancel() resolves null immediately and releases the listener", async () => {
	const {deps, state} = makeDeps();
	const handle = waitForFinalizedTranscript(deps);
	await sleep(10);
	handle.cancel();
	assert.equal(await handle.promise, null);
	assert.equal(state.unsubscribed, 1);
});

void test("stop signal resolves null at the next recheck", async () => {
	const {deps, state} = makeDeps({recheckIntervalMs: 15});
	const handle = waitForFinalizedTranscript(deps);
	await sleep(5);
	state.stopped = true;
	assert.equal(await handle.promise, null);
	assert.equal(state.unsubscribed, 1);
});

void test("a change-event storm resolves once and unsubscribes once", async () => {
	const {deps, state, fireChange} = makeDeps();
	const handle = waitForFinalizedTranscript(deps);
	await sleep(5);
	state.ready = TRANSCRIPT;
	fireChange();
	fireChange();
	fireChange();
	assert.equal(await handle.promise, TRANSCRIPT);
	await sleep(20); // let any stray rechecks land
	assert.equal(state.subscribed, 1);
	assert.equal(state.unsubscribed, 1);
});
