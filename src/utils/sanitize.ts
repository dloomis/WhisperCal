const ILLEGAL_FILENAME_CHARS = /[/\\:*?"<>|#[\]]/g;

/**
 * Sanitize a string for use as a filename.
 * Strips characters that are illegal in filenames across platforms.
 */
export function sanitizeFilename(name: string): string {
	return name.replace(ILLEGAL_FILENAME_CHARS, "").trim();
}
