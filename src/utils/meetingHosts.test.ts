import {test} from "node:test";
import assert from "node:assert/strict";
import {TEAMS_HOSTS, ZOOM_HOSTS, hostMatches} from "./meetingHosts";

void test("hostMatches: exact and subdomain", () => {
	assert.equal(hostMatches("teams.microsoft.com", TEAMS_HOSTS), true);
	assert.equal(hostMatches("gov.teams.microsoft.us", TEAMS_HOSTS), true);
	assert.equal(hostMatches("zoomgov.com", ZOOM_HOSTS), true);
	assert.equal(hostMatches("example.com", [...TEAMS_HOSTS, ...ZOOM_HOSTS]), false);
});
