/**
 * Rewrite an online-meeting join URL to its native app deep link when one
 * exists, so clicking joins directly instead of bouncing through a browser
 * interstitial. Unknown providers pass through unchanged.
 */
import {debug} from "./debug";

/**
 * Teams join-link hosts across clouds: commercial (teams.microsoft.com,
 * incl. GCC), personal (teams.live.com), US government GCC High/DoD
 * (gov/dod.teams.microsoft.us), and China 21Vianet (teams.microsoftonline.cn).
 */
const TEAMS_HOSTS = [
	"teams.microsoft.com",
	"teams.live.com",
	"teams.microsoft.us",
	"teams.microsoftonline.cn",
];

/** Zoom join-link hosts: commercial (zoom.us) and government (zoomgov.com). */
const ZOOM_HOSTS = ["zoom.us", "zoomgov.com"];

/** True when hostname is the base domain or any subdomain of it. */
function hostMatches(hostname: string, bases: string[]): boolean {
	return bases.some(base => hostname === base || hostname.endsWith(`.${base}`));
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
 */
export async function openMeetingUrl(url: string): Promise<void> {
	const electron = require("electron") as {shell: {openExternal(url: string): Promise<void>}};
	const deepLink = toMeetingDeepLink(url);
	if (deepLink !== url) {
		try {
			debug("meetingLink", `opening deep link: ${deepLink}`);
			await electron.shell.openExternal(deepLink);
			return;
		} catch (err) {
			// App not installed — fall back to the browser.
			debug("meetingLink", `deep link failed, falling back to browser: ${String(err)}`);
		}
	}
	await electron.shell.openExternal(url);
}
