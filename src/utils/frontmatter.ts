import type {App} from "obsidian";
import {TFile} from "obsidian";

export async function updateFrontmatter(
	app: App,
	filePath: string,
	key: string,
	value: string,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) return;

	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		frontmatter[key] = value;
	});
}
