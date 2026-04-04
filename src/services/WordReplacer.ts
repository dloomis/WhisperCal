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
 * Apply word replacements to a transcript file's body (preserving frontmatter).
 * Returns the number of individual replacements made, or 0 if nothing changed.
 */
export async function applyWordReplacements(
	app: App,
	transcriptPath: string,
	replacementFilePath: string,
): Promise<number> {
	// Load replacement mappings
	const mapFile = app.vault.getAbstractFileByPath(replacementFilePath);
	if (!(mapFile instanceof TFile)) return 0;
	const mapContent = await app.vault.cachedRead(mapFile);
	const replacements = parseReplacementFile(mapContent);
	if (replacements.length === 0) return 0;

	// Load transcript
	const transcriptFile = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(transcriptFile instanceof TFile)) return 0;
	const content = await app.vault.read(transcriptFile);

	// Split frontmatter from body to avoid corrupting YAML
	const fmEnd = content.indexOf("\n---", 1);
	if (fmEnd < 0) return 0; // no frontmatter — unexpected for a transcript
	const bodyStart = content.indexOf("\n", fmEnd + 4);
	if (bodyStart < 0) return 0;

	const frontmatter = content.slice(0, bodyStart);
	let body = content.slice(bodyStart);

	// Partition replacements by boundary type for efficient batching
	const wordBounded = new Map<string, string>();
	const custom: Replacement[] = [];
	for (const {search, replace} of replacements) {
		if (/^\w/.test(search) && /\w$/.test(search)) {
			wordBounded.set(search, replace);
		} else {
			custom.push({search, replace});
		}
	}

	let totalCount = 0;

	// Single-pass for word-bounded terms (the common case)
	if (wordBounded.size > 0) {
		const patterns = [...wordBounded.keys()]
			.sort((a, b) => b.length - a.length)
			.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		const re = new RegExp(`\\b(?:${patterns.join("|")})\\b`, "g");
		body = body.replace(re, (match) => {
			const r = wordBounded.get(match);
			if (r !== undefined) {
				totalCount++;
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
		body = body.replace(re, () => {
			totalCount++;
			return replace;
		});
	}

	if (totalCount === 0) return 0;

	await app.vault.modify(transcriptFile, frontmatter + body);
	return totalCount;
}
