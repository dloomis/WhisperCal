import {App, TFile, TFolder, normalizePath} from "obsidian";
import type {WhisperCalSettings} from "../settings";
import {FM} from "../constants";
import {readFmString, updateFrontmatter} from "../utils/frontmatter";
import {sanitizeFilename, yamlEscape} from "../utils/sanitize";
import {ensureFolder, getMarkdownFilesRecursive} from "../utils/vault";

/** Frontmatter keys specific to a meeting-series note. */
export const SERIES_FM = {
	SERIES_ID: "series_id",
	SERIES_SUBJECT: "series_subject",
	MATCH_SUBJECTS: "match_subjects",
	RESEARCH_NOTES: "research_notes",
} as const;

export const RESEARCH_INSTRUCTIONS_HEADING = "Research instructions";

export interface SeriesPrep {
	seriesNotePath: string;
	instruction: string;   // body under "## Research instructions", trimmed; "" if absent
	paths: string[];       // resolved vault paths from research_notes; [] if absent
}

/** Locate the series note for a meeting: by series_id, then by subject. */
export function findSeriesNote(
	app: App, settings: WhisperCalSettings, seriesId: string, subject: string,
): TFile | null {
	if (!settings.seriesNotesFolderPath) return null;
	const folder = app.vault.getAbstractFileByPath(settings.seriesNotesFolderPath);
	if (!(folder instanceof TFolder)) return null;
	const files = getMarkdownFilesRecursive(folder);

	// 1. Durable: by series_id
	if (seriesId) {
		for (const f of files) {
			const fm = app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm && fm[SERIES_FM.SERIES_ID] === seriesId) return f;
		}
	}
	if (!subject) return null;

	// 2. Canonical filename = sanitized subject
	const canonical = normalizePath(`${settings.seriesNotesFolderPath}/${sanitizeFilename(subject)}.md`);
	const direct = app.vault.getAbstractFileByPath(canonical);
	if (direct instanceof TFile) return direct;

	// 3. by series_subject / match_subjects
	for (const f of files) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm) continue;
		if (fm[SERIES_FM.SERIES_SUBJECT] === subject) return f;
		const alts: unknown = fm[SERIES_FM.MATCH_SUBJECTS];
		if (Array.isArray(alts) && alts.includes(subject)) return f;
	}
	return null;
}

/** Resolve prep for an occurrence note's frontmatter. null = no series note (feature dormant). */
export async function resolveSeriesPrep(
	app: App, settings: WhisperCalSettings, occurrenceFm: Record<string, unknown> | undefined,
): Promise<SeriesPrep | null> {
	if (!settings.seriesNotesFolderPath || !occurrenceFm) return null;
	const seriesId = readFmString(occurrenceFm, FM.MEETING_SERIES_ID) ?? "";
	const subject = readFmString(occurrenceFm, "meeting_subject") ?? "";
	const note = findSeriesNote(app, settings, seriesId, subject);
	if (!note) return null;

	const noteFm = app.metadataCache.getFileCache(note)?.frontmatter ?? {};
	// Self-heal: stamp series_id when matched by subject and missing.
	if (seriesId && !readFmString(noteFm, SERIES_FM.SERIES_ID)) {
		await updateFrontmatter(app, note.path, SERIES_FM.SERIES_ID, seriesId);
	}

	const content = await app.vault.cachedRead(note);
	const instruction = extractMarkdownSection(content, RESEARCH_INSTRUCTIONS_HEADING);
	const paths = parseWikilinkPaths(app, readFmString(noteFm, SERIES_FM.RESEARCH_NOTES), note.path);
	return {seriesNotePath: note.path, instruction, paths};
}

/** Create (or find) the series note for a meeting; returns its path and whether
 *  it was newly created (false = an existing note was found). */
export async function ensureSeriesNote(
	app: App, settings: WhisperCalSettings, seriesId: string, subject: string,
): Promise<{path: string; created: boolean}> {
	const existing = findSeriesNote(app, settings, seriesId, subject);
	if (existing) {
		const fm = app.metadataCache.getFileCache(existing)?.frontmatter ?? {};
		if (seriesId && !readFmString(fm, SERIES_FM.SERIES_ID)) {
			await updateFrontmatter(app, existing.path, SERIES_FM.SERIES_ID, seriesId);
		}
		return {path: existing.path, created: false};
	}
	await ensureFolder(app, settings.seriesNotesFolderPath);
	const path = normalizePath(`${settings.seriesNotesFolderPath}/${sanitizeFilename(subject)}.md`);
	const body = [
		"---",
		`series_id: "${yamlEscape(seriesId)}"`,
		`series_subject: "${yamlEscape(subject)}"`,
		`tags: [meeting-series]`,
		`research_notes: ""`,
		"---",
		"",
		// Guidance lives ABOVE the heading so it is not picked up as the instruction
		// body — extractMarkdownSection only reads lines after the heading.
		"<!-- Per-series prep for this recurring meeting. The text under the heading below is",
		"     appended to the research prompt each time you run Research on an occurrence.",
		"     List default context notes in `research_notes` above, e.g.",
		"     research_notes: \"[[Some Note]], [[Another Note]]\".",
		"     Example: List open items from the SDA Jira board and the action items from the",
		"     previous occurrence. -->",
		"",
		`## ${RESEARCH_INSTRUCTIONS_HEADING}`,
		"",
	].join("\n");
	const file = await app.vault.create(path, body);
	return {path: file.path, created: true};
}

/** Body under the first heading whose text == `heading` (case-insensitive, any level),
 *  up to the next heading of the same or higher level. Fenced code blocks (``` / ~~~)
 *  are skipped, so a markdown example containing `## ...` inside a fence does not
 *  prematurely terminate the section. */
function extractMarkdownSection(content: string, heading: string): string {
	const lines = content.split("\n");
	const target = heading.trim().toLowerCase();
	const isFence = (line: string): boolean => /^\s*(```|~~~)/.test(line);
	let start = -1, level = 0;
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (isFence(line)) { inFence = !inFence; continue; }
		if (inFence) continue;
		const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
		if (m && (m[2] as string).trim().toLowerCase() === target) { start = i + 1; level = (m[1] as string).length; break; }
	}
	if (start === -1) return "";
	const out: string[] = [];
	inFence = false;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i] as string;
		if (isFence(line)) inFence = !inFence;
		else if (!inFence) {
			const m = /^(#{1,6})\s+/.exec(line);
			if (m && (m[1] as string).length <= level) break;
		}
		out.push(line);
	}
	return out.join("\n").trim();
}

/** Parse a comma-joined "[[link]], [[link|alias]]" string into resolved vault paths. */
function parseWikilinkPaths(app: App, value: string | undefined, sourcePath: string): string[] {
	if (!value) return [];
	const paths: string[] = [];
	for (const m of value.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
		const dest = app.metadataCache.getFirstLinkpathDest((m[1] as string).trim(), sourcePath);
		if (dest) paths.push(dest.path);
	}
	return paths;
}
