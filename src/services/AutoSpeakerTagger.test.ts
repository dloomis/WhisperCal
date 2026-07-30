import {test} from "node:test";
import assert from "node:assert/strict";
import type {App, TFile} from "obsidian";
import {AutoSpeakerTagger, type AutoSpeakerTaggerDeps} from "./AutoSpeakerTagger";
import {setDebugLogging} from "../utils/debug";

// debug()'s skip() helper reads `window.whisperCalDebug` when the settings flag is off;
// there's no `window` under node:test, so it throws unless the flag short-circuits first.
setDebugLogging(true);

const TRANSCRIPT_FOLDER = "Transcripts";

// Fakes a TFile: this repo's "obsidian" package is types-only (no runtime — see the
// comment on makeHarness below), so there is no real TFile to construct or narrow via
// instanceof here.
function fakeFile(path: string): TFile {
	// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
	return {path, extension: "md"} as unknown as TFile;
}

/**
 * Narrow, purpose-typed view onto AutoSpeakerTagger's private queue/attempted state and its
 * isEligible/maybeEnqueue methods. Neither is part of the class's public surface (by design —
 * see AutoSpeakerTaggerDeps), so this is a deliberate, single, typed reach-in for white-box
 * testing rather than `any` scattered through each test body.
 */
interface AutoSpeakerTaggerInternals {
	queue: {file: TFile}[];
	attempted: Set<string>;
	isEligible(file: TFile): Promise<{ok: boolean}>;
	maybeEnqueue(file: TFile): Promise<void>;
}

function internals(tagger: AutoSpeakerTagger): AutoSpeakerTaggerInternals {
	return tagger as unknown as AutoSpeakerTaggerInternals;
}

/**
 * Minimal Obsidian deps sufficient to drive AutoSpeakerTagger.isEligible up to (and past)
 * the not-yet-finalized guard, WITHOUT reaching hasCachedProposals. That helper does
 * `app.vault.getAbstractFileByPath(…) instanceof TFile`, and this repo's "obsidian" package
 * is types-only — no runtime — so `TFile` is `undefined` at import time and ANY
 * `instanceof TFile` check throws unconditionally, regardless of what's on the left (see
 * SpeakerTagParser.test.ts for the same finding). That's a pre-existing gap in this test
 * environment, not something the guard introduces; the guard sits before that point in
 * isEligible specifically so its own behavior stays testable here.
 */
function makeHarness(opts: {
	fm: Record<string, unknown>;
	body: string;
	readError?: Error;
}): {tagger: AutoSpeakerTagger; file: TFile} {
	const file = fakeFile(`${TRANSCRIPT_FOLDER}/Some Meeting - Transcript.md`);
	const app = {
		metadataCache: {
			getFileCache: (f: TFile) => (f === file ? {frontmatter: opts.fm} : undefined),
			getFirstLinkpathDest: () => fakeFile("Meetings/Some Meeting.md"),
		},
		vault: {
			cachedRead: async (f: TFile) => {
				if (opts.readError) throw opts.readError;
				return f === file ? opts.body : "";
			},
			// Reached only once a body clears the not-yet-finalized guard, on the way to
			// hasCachedProposals — see the pre-existing "obsidian" gap documented above.
			getAbstractFileByPath: () => null,
		},
	};

	const deps = {
		app: app as unknown as App,
		getSettings: () => ({
			autoSummarizeAfterTagging: true,
			llmEnabled: true,
			speakerTaggingPromptPath: "Prompts/Speaker Tagging.md",
			transcriptFolderPath: TRANSCRIPT_FOLDER,
			autoTagLookbackHours: 48,
		}),
		jobs: {has: () => false},
		canStartLlm: () => true,
		isLlmDebugMode: () => false,
		runAutoTag: () => {
			throw new Error("runAutoTag must not be invoked for a deferred/ineligible file");
		},
		registerEvent: () => { /* not exercised: start() isn't called in these tests */ },
	} as unknown as AutoSpeakerTaggerDeps;

	return {tagger: new AutoSpeakerTagger(deps), file};
}

void test("AutoSpeakerTagger: defers (no enqueue, no attempted-mark) while the body still has a live 'Them' label", async () => {
	const liveBody = ["## Transcript", "**You**", "hi", "", "**Them**", "hello"].join("\n");
	const {tagger, file} = makeHarness({
		fm: {pipeline_state: "titled", meeting_note: "[[Some Meeting]]"},
		body: liveBody,
	});

	await internals(tagger).maybeEnqueue(file);

	assert.equal(internals(tagger).queue.length, 0, "must not enqueue a still-live transcript");
	assert.equal(
		internals(tagger).attempted.has(file.path),
		false,
		"must not mark attempted — a later metadataCache 'changed' event (Tome's rewrite) has to re-arm this file",
	);
});

void test("AutoSpeakerTagger: isEligible resolves ok:false directly for a live-labeled body (does not throw)", async () => {
	const liveBody = ["## Transcript", "**Them**", "hello"].join("\n");
	const {tagger, file} = makeHarness({
		fm: {pipeline_state: "titled", meeting_note: "[[Some Meeting]]"},
		body: liveBody,
	});

	const result = await internals(tagger).isEligible(file);
	assert.deepEqual(result, {ok: false});
});

void test("AutoSpeakerTagger: a body-read failure defers gracefully instead of crashing the eligibility check", async () => {
	const {tagger, file} = makeHarness({
		fm: {pipeline_state: "titled", meeting_note: "[[Some Meeting]]"},
		body: "",
		readError: new Error("ENOENT: file vanished mid-read"),
	});

	const result = await internals(tagger).isEligible(file);
	assert.deepEqual(result, {ok: false});
	assert.equal(internals(tagger).attempted.has(file.path), false);
});

void test("AutoSpeakerTagger: the not-yet-finalized guard clears once labels are diarized (only 'Them' trips it)", async () => {
	const finalizedBody = ["## Transcript", "**Speaker 1**", "hi", "", "**Speaker 2**", "hello"].join("\n");
	const {tagger, file} = makeHarness({
		fm: {pipeline_state: "titled", meeting_note: "[[Some Meeting]]"},
		body: finalizedBody,
	});

	// Past the guard, isEligible reaches hasCachedProposals, which this test
	// environment can't exercise (the pre-existing "obsidian" gap described on
	// makeHarness above) — it throws instead of returning normally. Asserting
	// THAT specific throw (rather than a plain {ok: false}) is how we confirm the
	// guard let a finalized body through instead of silently deferring it too.
	await assert.rejects(internals(tagger).isEligible(file), /instanceof/);
});
