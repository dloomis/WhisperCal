import {test} from "node:test";
import assert from "node:assert/strict";
import type {App} from "obsidian";
import {writeSpeakerProposals, type ProposedSpeakerMapping} from "./SpeakerTagParser";

function mapping(overrides: Partial<ProposedSpeakerMapping>): ProposedSpeakerMapping {
	return {
		index: 0,
		originalName: "Speaker 1",
		proposedName: "",
		confidence: "",
		evidence: "",
		speakerId: "",
		lineCount: 0,
		...overrides,
	};
}

/**
 * A vault stub that fails the test if it's ever touched. writeSpeakerProposals must refuse
 * a "Them" mapping before it reaches any vault/file I/O — the real "obsidian" package used
 * by this test runner has no runtime (`TFile` imports as undefined), so `instanceof TFile`
 * throws the moment real file resolution is attempted; the refusal path must return before
 * that point.
 */
function untouchableApp(): App {
	const fail = (): never => { throw new Error("writeSpeakerProposals touched the vault — refusal guard did not return early"); };
	return {
		vault: {getAbstractFileByPath: fail},
		fileManager: {processFrontMatter: fail},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any as App;
}

void test("writeSpeakerProposals: refuses when a mapping's originalName is the live placeholder 'Them'", async () => {
	await assert.doesNotReject(
		writeSpeakerProposals(untouchableApp(), "Transcripts/x.md", [
			mapping({index: 0, originalName: "Speaker 1", proposedName: "Alice"}),
			mapping({index: 1, originalName: "Them", proposedName: ""}),
		]),
	);
});

void test("writeSpeakerProposals: refuses even when 'Them' is the only mapping", async () => {
	await assert.doesNotReject(
		writeSpeakerProposals(untouchableApp(), "Transcripts/x.md", [
			mapping({index: 0, originalName: "Them"}),
		]),
	);
});
