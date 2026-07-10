const ILLEGAL_FILENAME_CHARS = /[/\\:*?"<>|#[\]]/g;

// Windows reserved device names — invalid as a bare filename even with an
// extension. Checked against the whole sanitized name (no extension here).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Sanitize a string for use as a filename.
 * Strips characters that are illegal in filenames across platforms, plus
 * Windows-specific hazards (trailing dots/spaces, reserved device names) —
 * applied everywhere so a vault synced from macOS to Windows stays valid.
 */
export function sanitizeFilename(name: string): string {
	let sanitized = name.replace(ILLEGAL_FILENAME_CHARS, "").trim();
	// Windows forbids trailing dots and spaces (silently stripped, causing mismatches).
	sanitized = sanitized.replace(/[. ]+$/, "");
	// Cap length so a long Outlook subject plus WhisperCal's own suffixes
	// (" - Transcript.voiceprints.json", ~30 chars) stays under Windows MAX_PATH
	// (260). Re-strip trailing dots/spaces the cut may have exposed.
	const MAX_LEN = 120;
	if (sanitized.length > MAX_LEN) sanitized = sanitized.slice(0, MAX_LEN).replace(/[. ]+$/, "");
	if (WINDOWS_RESERVED.test(sanitized)) sanitized = `${sanitized}-note`;
	return sanitized || "untitled";
}

/**
 * Reproduce the PRE-hardening filename — the sanitization that existed before the
 * trailing-dot/space strip and length cap were added — so a lookup can fall back
 * to artifacts written by older versions (e.g. a "Robert Smith Jr..json"
 * voiceprint library) instead of creating a duplicate. Returns null when it
 * equals the current sanitization (nothing legacy to probe).
 */
export function legacyFilename(name: string): string | null {
	let legacy = name.replace(ILLEGAL_FILENAME_CHARS, "").trim();
	if (WINDOWS_RESERVED.test(legacy)) legacy = `${legacy}-note`;
	legacy = legacy || "untitled";
	return legacy === sanitizeFilename(name) ? null : legacy;
}

/**
 * Escape a string for use inside a YAML double-quoted value.
 */
export function yamlEscape(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}
