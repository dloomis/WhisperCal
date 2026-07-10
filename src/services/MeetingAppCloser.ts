import {execFile} from "child_process";
import {Platform} from "obsidian";
import type {MeetingApp} from "../utils/meetingLink";
import {debug} from "../utils/debug";

/**
 * Quit the meeting's desktop app to disconnect the user from the call.
 *
 * There is no portable way to "leave the meeting" without automating the app's
 * own UI (e.g. AppleScript keystrokes), which wouldn't survive the planned
 * Windows port. So we take the pragmatic route the user accepted — terminate
 * the app process — using only the platform's own process tools: `killall` on
 * macOS/Linux (SIGTERM, so the app quits gracefully) and `taskkill` on Windows.
 *
 * Apps ship under different executable names across versions (classic vs. new
 * Teams; Zoom variants), so each app maps to several candidate names and we
 * signal every one, ignoring "no such process" errors.
 */
const PROCESS_NAMES: Record<MeetingApp, {darwin: string[]; win32: string[]}> = {
	teams: {
		// New Teams (2.x) runs as "MSTeams"; classic Teams as "Microsoft Teams".
		darwin: ["MSTeams", "Microsoft Teams"],
		win32: ["ms-teams.exe", "Teams.exe"],
	},
	zoom: {
		darwin: ["zoom.us"],
		win32: ["Zoom.exe"],
	},
};

/** Send a terminate signal to one named process; resolves regardless of result. */
function killByProcessName(name: string): Promise<void> {
	return new Promise(resolve => {
		// taskkill/killall exit non-zero when no matching process exists — that's
		// expected (the app may already be closed), so errors are swallowed.
		if (Platform.isWin) {
			// /F force-terminates. Without it, taskkill posts WM_CLOSE, which
			// Teams/Zoom intercept as "minimize to tray" — the call stays live
			// with mic/camera on while the UI implies the user has left.
			execFile("taskkill", ["/F", "/IM", name], {timeout: 5000}, () => resolve());
		} else {
			execFile("/usr/bin/killall", [name], {timeout: 5000}, () => resolve());
		}
	});
}

/**
 * Quit the desktop app for the given meeting provider. Best-effort: failures
 * (app already closed, tool missing) are logged, never surfaced — closing the
 * app is a courtesy on top of stopping the recording, which already succeeded.
 */
export async function closeMeetingApp(app: MeetingApp): Promise<void> {
	const names = Platform.isWin ? PROCESS_NAMES[app].win32 : PROCESS_NAMES[app].darwin;
	debug("meetingApp", `closing ${app}: signaling ${names.join(", ")}`);
	try {
		await Promise.all(names.map(killByProcessName));
	} catch (err) {
		debug("meetingApp", `close failed for ${app}: ${String(err)}`);
	}
}
