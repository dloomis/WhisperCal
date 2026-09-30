import {test} from "node:test";
import assert from "node:assert/strict";
import {stripJoinBlock} from "./meetingBody";

const RULE = "________________________________________________________________________________";

void test("removes a bracketed Teams GCC-High join block, keeps agenda", () => {
	const body = [
		"Agenda",
		"- Discuss project next steps",
		"",
		RULE,
		"Microsoft Teams meeting",
		"Join: [https://gov.teams.microsoft.us/meet/111222333444?p=x](https://gov.teams.microsoft.us/meet/111222333444?p=x)",
		"Meeting ID: 111 222 333 444",
		"Passcode: Ab1Cd2eF",
		"Dial in by phone",
		"Phone conference ID: 111 222 33#",
		RULE,
	].join("\n");
	assert.equal(stripJoinBlock(body), "Agenda\n- Discuss project next steps");
});

void test("removes a commercial Teams block", () => {
	const body = [
		"Weekly sync agenda",
		"",
		RULE,
		"Microsoft Teams meeting",
		"Join: https://teams.microsoft.com/meet/11122233344455?p=x",
		"Meeting ID: 111 222 333 444 55",
		"Passcode: Gh3Ij4kL",
		RULE,
	].join("\n");
	assert.equal(stripJoinBlock(body), "Weekly sync agenda");
});

void test("removes a Zoom block", () => {
	const body = [
		"Roadmap review",
		"",
		"---",
		"Join Zoom Meeting",
		"https://zoomgov.com/j/1234567890?pwd=abc",
		"Meeting ID: 123 456 7890",
		"Passcode: 55555",
		"---",
	].join("\n");
	assert.equal(stripJoinBlock(body), "Roadmap review");
});

void test("agenda-only body is unchanged (aside from trailing trim)", () => {
	const body = "Agenda\n- item one\n- item two";
	assert.equal(stripJoinBlock(body), "Agenda\n- item one\n- item two");
});

void test("does NOT strip a real divider in the agenda that lacks join markers", () => {
	const body = [
		"Agenda",
		"- Plan the offsite",
		"---",
		"Reminder: join us for lunch after",
	].join("\n");
	assert.equal(stripJoinBlock(body), body);
});

void test("removes a trailing block with no closing rule", () => {
	const body = [
		"Standup agenda",
		"",
		RULE,
		"Microsoft Teams meeting",
		"Join: https://teams.microsoft.com/meet/1?p=x",
	].join("\n");
	assert.equal(stripJoinBlock(body), "Standup agenda");
});

void test("is idempotent", () => {
	const body = [
		"Agenda",
		"",
		RULE,
		"Microsoft Teams meeting",
		"Join: https://teams.microsoft.com/meet/1?p=x",
		"Meeting ID: 1",
		RULE,
	].join("\n");
	const once = stripJoinBlock(body);
	assert.equal(stripJoinBlock(once), once);
});

void test("keeps agenda when a join URL is only quoted in prose between dividers", () => {
	const body = [
		"Agenda",
		"---",
		"Last week we used https://teams.microsoft.com/meet/123?p=x — do not reuse it.",
		"Bring your questions.",
		"---",
		"More agenda after",
	].join("\n");
	assert.equal(stripJoinBlock(body), body);
});

void test("does not leave a dangling rule when a user divider precedes the join block", () => {
	const body = [
		"Agenda",
		"- item",
		"---",
		"",
		RULE,
		"Microsoft Teams meeting",
		"Join: https://teams.microsoft.com/meet/1?p=x",
		"Meeting ID: 1",
		RULE,
	].join("\n");
	assert.equal(stripJoinBlock(body), "Agenda\n- item");
});
