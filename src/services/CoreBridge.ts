import type {App} from "obsidian";
import {WHISPERCORE_API_VERSION, type WhisperCoreApi} from "../types/whispercore";

/**
 * The ONLY place WhisperCal touches the plugin registry for WhisperCore
 * (mirror of the planned OrgBridge). Consumer rules (WhisperCore DESIGN §4.9,
 * WhisperOrg DESIGN §16.9): fetch fresh at every use — never cache across an
 * await; exact `apiVersion` match; boolean-first readiness; absent ≡ disabled ≡
 * not-ready ≡ mismatched, all collapsing to `null`.
 *
 * WhisperCore is a HARD prerequisite (DESIGN §4.9 exception, D2): a null return
 * means WhisperCal gates its calendar/LLM features behind an install message —
 * there is no native auth fallback.
 */

let warnedVersion: number | null = null;

export function getWhisperCoreApi(app: App): WhisperCoreApi | null {
	const plugin = app.plugins?.getPlugin?.("whispercore") as {api?: WhisperCoreApi} | null;
	const api = plugin?.api;
	if (!api) return null;
	if (api.apiVersion !== WHISPERCORE_API_VERSION) {
		// One-time console warning naming both versions (drift alarm).
		if (warnedVersion !== api.apiVersion) {
			warnedVersion = api.apiVersion;
			console.warn(
				`[WhisperCal] WhisperCore API version mismatch: expected ${WHISPERCORE_API_VERSION}, ` +
				`found ${api.apiVersion}. Update both plugins to compatible versions.`,
			);
		}
		return null;
	}
	if (!api.isReady()) return null;
	return api;
}
