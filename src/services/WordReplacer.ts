import {App, Notice, TFile} from "obsidian";

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

export interface ReplacementHit {
	from: string;
	to: string;
	count: number;
}

export interface ReplacementResult {
	text: string;
	totalCount: number;
	hits: ReplacementHit[];
}

/**
 * Run replacements on a string. Returns the transformed text, total count,
 * and per-rule hit details.
 */
export function runReplacements(text: string, replacements: Replacement[]): ReplacementResult {
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

	const hitCounts = new Map<string, {to: string; count: number}>();
	const track = (from: string, to: string) => {
		const existing = hitCounts.get(from);
		if (existing) {
			existing.count++;
		} else {
			hitCounts.set(from, {to, count: 1});
		}
	};

	// Single-pass for word-bounded terms (the common case)
	if (wordBounded.size > 0) {
		const patterns = [...wordBounded.keys()]
			.sort((a, b) => b.length - a.length)
			.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		const re = new RegExp(`\\b(?:${patterns.join("|")})\\b`, "g");
		text = text.replace(re, (match) => {
			const r = wordBounded.get(match);
			if (r !== undefined) {
				track(match, r);
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
			track(search, replace);
			return replace;
		});
	}

	const hits: ReplacementHit[] = [];
	let totalCount = 0;
	for (const [from, {to, count}] of hitCounts) {
		hits.push({from, to, count});
		totalCount += count;
	}

	return {text, totalCount, hits};
}

/**
 * Apply word replacements to a file's body (preserving any frontmatter).
 * Returns the hit details, or an empty result if nothing changed.
 */
export async function applyWordReplacements(
	app: App,
	filePath: string,
	replacementFilePath: string,
): Promise<ReplacementResult> {
	const empty: ReplacementResult = {text: "", totalCount: 0, hits: []};
	const replacements = await loadReplacements(app, replacementFilePath);
	if (replacements.length === 0) return empty;

	const file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) return empty;

	let result: ReplacementResult = empty;
	await app.vault.process(file, (content) => {
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

		result = runReplacements(body, replacements);
		if (result.totalCount === 0) return content; // no changes
		return frontmatter + result.text;
	});

	return result;
}

const MAX_NOTICE_HITS = 10;

/** Show a Notice summarizing which words were replaced. */
export function showReplacementNotice(result: ReplacementResult): void {
	if (result.totalCount === 0) {
		new Notice("No matches found \u2014 no changes made");
		return;
	}

	const frag = document.createDocumentFragment();
	frag.createEl("strong", {text: `Applied ${result.totalCount} word replacement${result.totalCount === 1 ? "" : "s"}`});

	const shown = result.hits.slice(0, MAX_NOTICE_HITS);
	for (const hit of shown) {
		const line = frag.createEl("div");
		line.createEl("span", {text: `  ${hit.from} \u2192 ${hit.to}`});
		if (hit.count > 1) {
			line.createEl("span", {text: ` (${hit.count}\u00D7)`, cls: "mod-muted"});
		}
	}
	if (result.hits.length > MAX_NOTICE_HITS) {
		frag.createEl("div", {text: `  \u2026and ${result.hits.length - MAX_NOTICE_HITS} more`, cls: "mod-muted"});
	}

	new Notice(frag, 8000);
}
