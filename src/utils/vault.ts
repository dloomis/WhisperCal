import {App, TFile, TFolder} from "obsidian";

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
		const tags = fm["tags"];
		if (Array.isArray(tags) && tags.includes("transcript")) continue;
		const sid = fm["macwhisper_session_id"] as string | undefined;
		if (sid) linked.add(sid);
	}
	return linked;
}
