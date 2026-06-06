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
		if (!(file instanceof TFile)) {
			console.error(`[WhisperCal] updateFrontmatter: no file at "${filePath}" — skipping {${key}}`);
			return;
		}

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
		if (!(file instanceof TFile)) {
			console.error(`[WhisperCal] batchUpdateFrontmatter: no file at "${filePath}" — skipping {${Object.keys(updates).join(", ")}}`);
			return;
		}

		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(updates)) {
				frontmatter[key] = value;
			}
		});
	});
}

/**
 * Read a frontmatter value as a string. Returns undefined if the key is missing,
 * the frontmatter is undefined, or the value is not a string.
 */
export function readFmString(
	fm: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const v = fm?.[key];
	return typeof v === "string" ? v : undefined;
}

/**
 * Detect a single-source recording from transcript frontmatter — a voice memo
 * or a recording where diarization collapsed to at most one speaker. These
 * often capture more people than the mic suggests (e.g. a phone call held up
 * to the mic), so speaker tagging benefits from per-run hints.
 *
 * Checks, in order:
 * - Tome's `source_app: Voice Memo`
 * - MacWhisper's `speaker_count` (number) ≤ 1
 * - Tome's `attendees` list length ≤ 1
 */
export function isSingleSourceTranscript(fm: Record<string, unknown> | undefined): boolean {
	if (!fm) return false;
	if (fm["source_app"] === "Voice Memo") return true;
	const speakerCount = fm["speaker_count"];
	if (typeof speakerCount === "number") return speakerCount <= 1;
	const attendees = fm["attendees"];
	if (Array.isArray(attendees)) return attendees.length <= 1;
	return false;
}

export async function removeFrontmatterKeys(
	app: App,
	filePath: string,
	keys: string[],
): Promise<void> {
	await enqueue(filePath, async () => {
		const file = app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			console.error(`[WhisperCal] removeFrontmatterKeys: no file at "${filePath}" — skipping {${keys.join(", ")}}`);
			return;
		}

		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			for (const key of keys) {
				delete frontmatter[key];
			}
		});
	});
}
