import {App, TFile, TFolder} from "obsidian";
import {FM} from "../constants";

/**
 * Strip wiki-link brackets and optional display-text alias from a string.
 * e.g. "[[Some Note]]" → "Some Note", "[[path|display]]" → "path"
 */
export function stripWikiLink(raw: string): string {
	return raw.replace(/^\[\[/, "").replace(/(\|.*?)?\]\]$/, "").trim();
}

/**
 * Resolve a frontmatter wiki-link value (e.g. "[[Some Note]]") to a TFile.
 * Returns null if the value is missing, empty, or the target doesn't exist.
 */
export function resolveWikiLink(
	app: App,
	fm: Record<string, unknown>,
	key: string,
	sourcePath: string,
): TFile | null {
	const raw = fm[key];
	if (!raw || typeof raw !== "string" || !raw.trim()) return null;
	const linktext = stripWikiLink(raw);
	return app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
}

/**
 * Resolve the audio recording for a transcript so the speaker-tag modal can
 * offer click-to-play per timestamp.
 *
 * Tome normally writes `recording: [[<basename>.m4a]]` into the transcript
 * frontmatter, but that field is sometimes absent — e.g. "Call"-source sessions
 * where Tome wrote the transcript and exported the audio but never wrote the
 * link. The audio file, when present, is always named `<transcript-basename>.m4a`
 * and lives in the vault's Audio folder; Obsidian resolves it by basename the
 * same way the wiki-link would have, so fall back to that convention before
 * giving up.
 */
export function resolveTranscriptAudio(
	app: App,
	transcriptFile: TFile,
	transcriptFm: Record<string, unknown>,
): TFile | null {
	const linked = resolveWikiLink(app, transcriptFm, "recording", transcriptFile.path);
	if (linked) return linked;
	return app.metadataCache.getFirstLinkpathDest(`${transcriptFile.basename}.m4a`, transcriptFile.path);
}

/**
 * Recursively collect all markdown files in a folder.
 */
export function getMarkdownFilesRecursive(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "md") {
			files.push(child);
		} else if (child instanceof TFolder) {
			files.push(...getMarkdownFilesRecursive(child));
		}
	}
	return files;
}

/**
 * Ensure a vault folder exists, creating it if necessary.
 */
export async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(folderPath);
	if (existing instanceof TFolder) return;
	try {
		await app.vault.createFolder(folderPath);
	} catch {
		// Folder may already exist (race condition)
	}
}

/**
 * Collect all MacWhisper session IDs that are already linked to notes in the vault.
 */
export function getLinkedSessionIds(app: App): Set<string> {
	const linked = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		// Skip transcript files — the owning meeting note holds the canonical link
		const tags: unknown = fm["tags"];
		if (Array.isArray(tags) && (tags as string[]).includes("transcript")) continue;
		const sid = fm[FM.MACWHISPER_SESSION_ID] as string | undefined;
		if (sid) linked.add(sid);
		// Merged notes carry every source session id in an array
		const sids: unknown = fm[FM.MACWHISPER_SESSION_IDS];
		if (Array.isArray(sids)) {
			for (const s of sids) {
				if (typeof s === "string" && s) linked.add(s);
			}
		}
	}
	return linked;
}
