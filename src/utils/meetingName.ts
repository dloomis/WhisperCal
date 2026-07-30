/**
 * Normalize a meeting/transcript name for fuzzy equality: drop a leading ISO date prefix
 * (note templates often prepend "{{date}} - ", which the calendar subject lacks), lowercase,
 * and strip everything that isn't a letter or digit. Used to decide whether an unlinked
 * transcript "obviously" belongs to a calendar meeting.
 *
 * Stripping punctuation (not just collapsing whitespace) matters: transcript/note titles
 * come through filename sanitization that drops characters like "/" and '"', so a subject
 * such as "Platform / Data Weekly Sync" only ever appears as "Platform  Data Weekly Sync" on
 * the file side. Comparing alphanumerics-only erases that asymmetry. Unicode letters are
 * kept so non-ASCII names don't collapse below the caller's too-generic length guard.
 */
export function normalizeMeetingName(s: string): string {
	return s
		.replace(/^\d{4}-\d{2}-\d{2}\s*[-–—]?\s*/, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}
