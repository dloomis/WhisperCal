/**
 * Conditional debug logging gated behind a runtime flag.
 *
 * Enable from the plugin settings: WhisperCal → "Debug logging" toggle.
 * The output prints to the Obsidian developer console (Cmd+Opt+I → Console),
 * filterable by the "[WhisperCal:" prefix.
 *
 * Power users can also override from the console without touching settings:
 *   window.whisperCalDebug = true   // force on
 *   window.whisperCalDebug = false  // (settings toggle still applies)
 */

declare global {
	interface Window {
		whisperCalDebug?: boolean;
	}
}

/** Driven by the "Debug logging" settings toggle via setDebugLogging(). */
let settingEnabled = false;

/** Sync the debug flag with the plugin setting. Called on load and on settings change. */
export function setDebugLogging(enabled: boolean): void {
	settingEnabled = enabled;
}

/** Log a debug message when enabled via the settings toggle or the window override. */
export function debug(namespace: string, message: string, ...args: unknown[]): void {
	if (settingEnabled || window.whisperCalDebug) {
		console.debug(`[WhisperCal:${namespace}]`, message, ...args);
	}
}
