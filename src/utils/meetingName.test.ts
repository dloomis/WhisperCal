import {test} from "node:test";
import assert from "node:assert/strict";
import {normalizeMeetingName} from "./meetingName";

// The auto-link matcher compares a calendar subject against a transcript/note title that
// came through filename sanitization (Tome and NoteCreator drop or replace characters like
// "/" and '"'). Normalization must erase that difference or subjects containing those
// characters can never auto-link.

void test("slash in subject vs slash-stripped filename title normalize equal", () => {
	assert.equal(
		normalizeMeetingName("Apollo Tag-up w/Ops & QA"),
		normalizeMeetingName("Apollo Tag-up wOps & QA"),
	);
});

void test("slash with surrounding spaces vs collapsed filename title normalize equal", () => {
	assert.equal(
		normalizeMeetingName("Platform / Data Weekly Sync"),
		normalizeMeetingName("Platform  Data Weekly Sync"),
	);
});

void test("mid-word slash normalizes equal to its sanitized form", () => {
	assert.equal(
		normalizeMeetingName("Infra/KM Azure networking weekly"),
		normalizeMeetingName("InfraKM Azure networking weekly"),
	);
});

void test("double quotes in subject vs quote-stripped filename title normalize equal", () => {
	assert.equal(
		normalizeMeetingName('"Managed Services" RACI review'),
		normalizeMeetingName("Managed Services RACI review"),
	);
});

void test("normalized form is lowercase alphanumerics only", () => {
	assert.equal(normalizeMeetingName("Apollo Tag-up w/Ops & QA"), "apollotagupwopsqa");
});

void test("leading ISO date prefix is stripped", () => {
	assert.equal(
		normalizeMeetingName("2026-07-27 - Weekly Sync"),
		normalizeMeetingName("Weekly Sync"),
	);
});

void test("date-prefixed title endsWith the bare subject (call-site suffix match)", () => {
	const recName = normalizeMeetingName("2026-07-14 - Apollo Tag-up w/Ops & QA");
	const subj = normalizeMeetingName("Apollo Tag-up wOps  QA");
	assert.ok(recName.endsWith(subj));
});

void test("non-ASCII letters survive normalization (no collapse to empty)", () => {
	assert.equal(normalizeMeetingName("Café Sync"), "cafésync");
});

void test("generic short names stay below the call-site length guard", () => {
	// findObviousMeeting rejects names shorter than 4 chars as too generic to match.
	assert.ok(normalizeMeetingName("1:1").length < 4);
});
