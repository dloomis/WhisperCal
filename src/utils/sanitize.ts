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
	if (WINDOWS_RESERVED.test(sanitized)) sanitized = `${sanitized}-note`;
	return sanitized || "untitled";
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
