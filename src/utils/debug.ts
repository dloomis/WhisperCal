/**
 * Conditional debug logging gated behind a runtime flag.
 *
 * Enable from the Obsidian developer console:
 *   window.whisperCalDebug = true
 *
 * Disable:
 *   window.whisperCalDebug = false
 */

declare global {
	interface Window {
		whisperCalDebug?: boolean;
	}
}

/** Log a debug message when `window.whisperCalDebug` is truthy. */
export function debug(namespace: string, message: string, ...args: unknown[]): void {
	if (window.whisperCalDebug) {
		console.debug(`[WhisperCal:${namespace}]`, message, ...args);
	}
}
