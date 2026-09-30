/**
 * Rewrite an online-meeting join URL to its native app deep link when one
 * exists, so clicking joins directly instead of bouncing through a browser
 * interstitial. Unknown providers pass through unchanged.
 */
import {shell} from "electron";
import {debug} from "./debug";
import {TEAMS_HOSTS, ZOOM_HOSTS, hostMatches} from "./meetingHosts";

/**
 * The desktop app a join URL launches. Used to close that app when a
 * WhisperCal-launched recording is stopped (see MeetingAppCloser). Only
 * providers with a native desktop client we can identify are listed;
 * browser-only meetings return null (nothing to close).
 */
export type MeetingApp = "teams" | "zoom";

/** Which desktop app a join URL opens, or null when the provider is unknown. */
export function meetingAppForUrl(url: string): MeetingApp | null {
	try {
		const {hostname} = new URL(url);
		if (hostMatches(hostname, TEAMS_HOSTS)) return "teams";
		if (hostMatches(hostname, ZOOM_HOSTS)) return "zoom";
	} catch {
		// Not a parseable URL.
	}
	return null;
}

export function toMeetingDeepLink(url: string): string {
	try {
		const parsed = new URL(url);
		// Teams: msteams: scheme opens the meeting directly in the app. The
		// original host is preserved so cloud routing (gov, China) is intact.
		if (hostMatches(parsed.hostname, TEAMS_HOSTS)) {
			return `msteams://${parsed.hostname}${parsed.pathname}${parsed.search}`;
		}
		// Zoom: zoommtg: scheme needs the meeting number and passcode as
		// query params rather than the /j/<id> path form.
		if (hostMatches(parsed.hostname, ZOOM_HOSTS)) {
			const confno = /^\/[jw]\/(\d+)/.exec(parsed.pathname)?.[1];
			if (confno) {
				const pwd = parsed.searchParams.get("pwd");
				const pwdParam = pwd ? `&pwd=${encodeURIComponent(pwd)}` : "";
				return `zoommtg://${parsed.hostname}/join?action=join&confno=${confno}${pwdParam}`;
			}
		}
	} catch {
		// Not a parseable URL — leave as-is.
	}
	return url;
}

/**
 * Open a join URL, preferring the native app deep link. If no app is
 * registered for the protocol (macOS reports this as an openExternal
 * rejection), fall back to opening the original URL in the browser.
 * Returns true when a launch succeeded (deep link or browser fallback),
 * false when even the browser fallback failed.
 */
export async function openMeetingUrl(url: string): Promise<boolean> {
	const deepLink = toMeetingDeepLink(url);
	if (deepLink !== url) {
		try {
			debug("meetingLink", `opening deep link: ${deepLink}`);
			await shell.openExternal(deepLink);
			return true;
		} catch (err) {
			// App not installed — fall back to the browser.
			debug("meetingLink", `deep link failed, falling back to browser: ${String(err)}`);
		}
	}
	try {
		await shell.openExternal(url);
		return true;
	} catch (err) {
		debug("meetingLink", `browser launch failed: ${String(err)}`);
		return false;
	}
}
