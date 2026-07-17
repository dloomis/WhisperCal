import type {App} from "obsidian";
import {TFile, parseYaml} from "obsidian";

/**
 * Offset at which the note body starts: just past a leading YAML frontmatter block, or 0
 * when there is none. The one definition of "where does frontmatter end", for the passes
 * that rewrite body text and must not touch YAML.
 *
 * Requires the block to actually open the file — scanning for a bare `\n---` would treat a
 * horizontal rule as a frontmatter close and hand back a "body" missing everything above
 * it. A closing `---` on the final line yields an offset at end-of-content (empty body).
 */
export function bodyStartOffset(content: string): number {
	if (!content.startsWith("---")) return 0;
	const close = content.indexOf("\n---", 3);
	if (close < 0) return 0;
	const afterClose = content.indexOf("\n", close + 4);
	return afterClose >= 0 ? afterClose + 1 : content.length;
}

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

/**
 * Best-effort count of distinct diarized speakers from transcript frontmatter — how many
 * voices the diarizer actually separated, not how many people were in the room. Prefers
 * MacWhisper's `speaker_count`, then the `attendees` list length (Tome writes one entry per
 * diarized label, e.g. "Speaker 1", "Speaker 2"). Returns 0 when neither is present.
 *
 * Used to tell a genuinely single-voice recording (needs a manual "who's who" hint) from a
 * single-mic recording the diarizer still split into multiple speakers (which voiceprint
 * matching can identify on its own).
 */
export function diarizedSpeakerCount(fm: Record<string, unknown> | undefined): number {
	if (!fm) return 0;
	const speakerCount = fm["speaker_count"];
	if (typeof speakerCount === "number") return speakerCount;
	const attendees = fm["attendees"];
	if (Array.isArray(attendees)) return attendees.length;
	return 0;
}

/**
 * Re-apply selected frontmatter fields from a pre-edit snapshot of the file.
 *
 * Guards against an in-place edit (e.g. the speaker-tagging LLM, which is told
 * never to touch frontmatter but isn't otherwise constrained) dropping or
 * rewriting externally-owned fields like the `recording` audio link. Only fields
 * present in the snapshot are restored, and only when the current value differs;
 * fields the snapshot never had are left alone, and everything else in the
 * current frontmatter is preserved.
 */
export async function restoreFrontmatterFields(
	app: App,
	filePath: string,
	snapshot: string,
	keys: string[],
): Promise<void> {
	const m = snapshot.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m || !m[1]) return; // snapshot had no frontmatter — nothing to restore
	let original: Record<string, unknown> | null;
	try {
		original = parseYaml(m[1]) as Record<string, unknown> | null;
	} catch {
		console.warn(`[WhisperCal] restoreFrontmatterFields: unparseable snapshot frontmatter for "${filePath}" — skipping`);
		return;
	}
	if (!original || typeof original !== "object") return;
	const snap = original;
	const toRestore = keys.filter(k => snap[k] !== undefined);
	if (toRestore.length === 0) return;

	await enqueue(filePath, async () => {
		const file = app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			console.error(`[WhisperCal] restoreFrontmatterFields: no file at "${filePath}" — skipping {${toRestore.join(", ")}}`);
			return;
		}
		await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			for (const key of toRestore) {
				// Deep-compare so we only rewrite when the value actually changed.
				if (JSON.stringify(frontmatter[key]) !== JSON.stringify(snap[key])) {
					frontmatter[key] = snap[key];
				}
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
