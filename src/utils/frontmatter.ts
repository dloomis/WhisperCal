import type {App} from "obsidian";
import {TFile} from "obsidian";

/**
 * Per-file queue to serialize processFrontMatter calls.
 * Concurrent read-modify-write on the same file causes data loss
 * (e.g. transcript link overwritten by a pipeline_state mirror update).
 */
const fileQueues = new Map<string, Promise<void>>();

function enqueue(filePath: string, fn: () => Promise<void>): Promise<void> {
	const prev = fileQueues.get(filePath) ?? Promise.resolve();
	const next = prev.then(fn, fn); // run even if previous rejected
	fileQueues.set(filePath, next);
	// Clean up entry when queue drains to avoid leaking memory
	void next.then(() => {
		if (fileQueues.get(filePath) === next) fileQueues.delete(filePath);
	});
	return next;
}

export async function updateFrontmatter(
	app: App,
	filePath: string,
	key: string,
	value: string,
): Promise<void> {
	await enqueue(filePath, async () => {
		const file = app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			frontmatter[key] = value;
		});
	});
}

export async function batchUpdateFrontmatter(
	app: App,
	filePath: string,
	updates: Record<string, string>,
): Promise<void> {
	await enqueue(filePath, async () => {
		const file = app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(updates)) {
				frontmatter[key] = value;
			}
		});
	});
}

export async function removeFrontmatterKeys(
	app: App,
	filePath: string,
	keys: string[],
): Promise<void> {
	await enqueue(filePath, async () => {
		const file = app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			for (const key of keys) {
				delete frontmatter[key];
			}
		});
	});
}
