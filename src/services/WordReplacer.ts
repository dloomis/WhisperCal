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

	// Apply replacements (case-sensitive, whole-word where possible)
	let totalCount = 0;
	for (const {search, replace} of replacements) {
		// Escape regex special chars in search term
		const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// Use word boundaries when the search term starts/ends with word chars
		const prefix = /^\w/.test(search) ? "\\b" : "";
		const suffix = /\w$/.test(search) ? "\\b" : "";
		const re = new RegExp(`${prefix}${escaped}${suffix}`, "g");
		let count = 0;
		body = body.replace(re, () => {
			count++;
			return replace;
		});
		totalCount += count;
	}

	if (totalCount === 0) return 0;

	await app.vault.modify(transcriptFile, frontmatter + body);
	return totalCount;
}
