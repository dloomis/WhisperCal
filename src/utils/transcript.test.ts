import {test} from "node:test";
import assert from "node:assert/strict";
import {transcriptBody, findSpeakerLabels, hasLiveLegLabels} from "./transcript";

void test("hasLiveLegLabels: true when a live 'Them' label is present", () => {
	const body = [
		"## Transcript",
		"**You**",
		"Hi there.",
		"",
		"**Them**",
		"Hello, how are you?",
	].join("\n");
	assert.equal(hasLiveLegLabels(body), true);
});

void test("hasLiveLegLabels: false once labels are diarized Speaker N (finalized)", () => {
	const body = [
		"## Transcript",
		"**Speaker 1**",
		"Hi there.",
		"",
		"**Speaker 2**",
		"Hello, how are you?",
		"",
		"**You**",
		"Doing well.",
	].join("\n");
	assert.equal(hasLiveLegLabels(body), false);
});

void test("hasLiveLegLabels: false on an empty or speakerless body", () => {
	assert.equal(hasLiveLegLabels(""), false);
	assert.equal(hasLiveLegLabels("## Transcript\nNo speaker lines here.\n"), false);
});

void test("hasLiveLegLabels: a 'Them' that isn't an exact label line (substring) doesn't match", () => {
	const body = [
		"## Transcript",
		"**Speaker 1**",
		"Tell them I said hi.", // prose containing "them", not a label line
	].join("\n");
	assert.equal(hasLiveLegLabels(body), false);
});

void test("hasLiveLegLabels composes with transcriptBody + findSpeakerLabels the same way callers use it", () => {
	const content = [
		"---",
		"pipeline_state: titled",
		"attendees: []",
		"---",
		"",
		"## Transcript",
		"**You**",
		"line one",
		"",
		"**Them**",
		"line two",
	].join("\n");
	const body = transcriptBody(content);
	assert.equal(findSpeakerLabels(body).some(l => l.name === "Them"), true);
	assert.equal(hasLiveLegLabels(body), true);
});
