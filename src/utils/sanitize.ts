const ILLEGAL_FILENAME_CHARS = /[/\\:*?"<>|#[\]]/g;

/**
 * Sanitize a string for use as a filename.
 * Strips characters that are illegal in filenames across platforms.
 */
export function sanitizeFilename(name: string): string {
	const sanitized = name.replace(ILLEGAL_FILENAME_CHARS, "").trim();
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
