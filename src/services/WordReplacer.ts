import {App, TFile} from "obsidian";

interface Replacement {
	search: string;
	replace: string;
}

/**
 * Parse a word replacement mapping file (CSV: one pair per line, first comma splits).
 * Lines starting with # are comments; blank lines are skipped.
 *
 * Example file:
 *   # Fix common transcription errors
 *   teh,the
 *   recieve,receive
 *   Jonh,John
 */
export function parseReplacementFile(content: string): Replacement[] {
	const replacements: Replacement[] = [];
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf(",");
		if (idx < 1) continue; // no comma or empty search term
		const search = line.slice(0, idx).trim();
		const replace = line.slice(idx + 1).trim();
		if (search && search !== replace) {
			replacements.push({search, replace});
		}
	}
	return replacements;
}

/**
 * Load replacement pairs from a vault file. Returns empty array if file
 * doesn't exist or contains no valid rules.
 */
export async function loadReplacements(app: App, replacementFilePath: string): Promise<Replacement[]> {
	const mapFile = app.vault.getAbstractFileByPath(replacementFilePath);
	if (!(mapFile instanceof TFile)) return [];
	const mapContent = await app.vault.cachedRead(mapFile);
	return parseReplacementFile(mapContent);
}

/**
 * Run replacements on a string. Returns the transformed text and a count
 * of individual substitutions made.
 */
export function runReplacements(text: string, replacements: Replacement[]): {text: string; count: number} {
	// Partition by boundary type for efficient batching
	const wordBounded = new Map<string, string>();
	const custom: Replacement[] = [];
	for (const {search, replace} of replacements) {
		if (/^\w/.test(search) && /\w$/.test(search)) {
			wordBounded.set(search, replace);
		} else {
			custom.push({search, replace});
		}
	}

	let count = 0;

	// Single-pass for word-bounded terms (the common case)
	if (wordBounded.size > 0) {
		const patterns = [...wordBounded.keys()]
			.sort((a, b) => b.length - a.length)
			.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		const re = new RegExp(`\\b(?:${patterns.join("|")})\\b`, "g");
		text = text.replace(re, (match) => {
			const r = wordBounded.get(match);
			if (r !== undefined) {
				count++;
				return r;
			}
			return match;
		});
	}

	// Individual passes for non-word-bounded terms (rare)
	for (const {search, replace} of custom) {
		const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const prefix = /^\w/.test(search) ? "\\b" : "";
		const suffix = /\w$/.test(search) ? "\\b" : "";
		const re = new RegExp(`${prefix}${escaped}${suffix}`, "g");
		text = text.replace(re, () => {
			count++;
			return replace;
		});
	}

	return {text, count};
}

/**
 * Apply word replacements to a file's body (preserving any frontmatter).
 * Returns the number of individual replacements made, or 0 if nothing changed.
 */
export async function applyWordReplacements(
	app: App,
	filePath: string,
	replacementFilePath: string,
): Promise<number> {
	const replacements = await loadReplacements(app, replacementFilePath);
	if (replacements.length === 0) return 0;

	const file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) return 0;
	const content = await app.vault.read(file);

	// Split frontmatter from body to avoid corrupting YAML
	let frontmatter = "";
	let body = content;
	const fmEnd = content.indexOf("\n---", 1);
	if (fmEnd >= 0) {
		const bodyStart = content.indexOf("\n", fmEnd + 4);
		if (bodyStart >= 0) {
			frontmatter = content.slice(0, bodyStart);
			body = content.slice(bodyStart);
		}
	}

	const result = runReplacements(body, replacements);
	if (result.count === 0) return 0;

	await app.vault.modify(file, frontmatter + result.text);
	return result.count;
}
