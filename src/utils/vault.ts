import {App, TFile, TFolder} from "obsidian";

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
	const linktext = raw.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
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
