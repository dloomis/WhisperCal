/**
 * Convert an ALL-CAPS word to title case. Mixed-case words are left as-is
 * to preserve names like "DeAndrea" or "McCaughey".
 */
function smartCase(word: string): string {
	if (!word) return "";
	if (word === word.toUpperCase() && word.length > 1) {
		return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
	}
	return word;
}

/**
 * Parse an Outlook/Exchange display name (often in DoD format) into
 * a clean "First Last" suitable for an Obsidian wiki link.
 *
 * Handles:
 * - DoD comma format: "GILLEY, KIRK A CTR USAF AFMC 45 TS/TGAB" → "Kirk Gilley"
 * - Bracket suffixes:  "Wilson, Lara [USA" → "Lara Wilson"
 * - Simple names:      "Dan Loomis" → "Dan Loomis"
 * - Middle initials:   "Aaron D Falk" → "Aaron Falk"
 * - Email-only:        "mike.mariani@l3harris.com" → "Mike Mariani"
 */
export function parseDisplayName(name: string, email: string): string {
	// If name is empty or is just an email address, derive from email
	if (!name || name.includes("@")) {
		if (!email) return name || "Unknown";
		const local = email.split("@")[0] ?? "";
		const parts = local.split(/[._-]/);
		return parts.map(smartCase).join(" ");
	}

	// Strip bracket suffixes like "[USA]" or "[USA"
	const cleaned = name.replace(/\s*\[.*$/, "").trim();
	if (!cleaned) return name;

	if (cleaned.includes(",")) {
		// "LAST, FIRST M RANK ORG..." format
		const commaIdx = cleaned.indexOf(",");
		const last = cleaned.substring(0, commaIdx).trim();
		const afterComma = cleaned.substring(commaIdx + 1).trim().split(/\s+/);
		const first = afterComma[0] ?? "";
		return `${smartCase(first)} ${smartCase(last)}`;
	}

	// Simple "First [Middle] Last" format
	const words = cleaned.split(/\s+/);
	if (words.length <= 2) {
		return words.map(smartCase).join(" ");
	}
	// 3+ words: first and last, drop middle initials
	return `${smartCase(words[0] ?? "")} ${smartCase(words[words.length - 1] ?? "")}`;
}
