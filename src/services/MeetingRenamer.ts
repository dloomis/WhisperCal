import {App, Notice, TFile, normalizePath} from "obsidian";
import type {RelatedFile} from "./MeetingDeleter";

export interface RenameMeetingResult {
	/** Number of files actually renamed (note + any related files). */
	renamed: number;
}

/**
 * Compute the new path for a file whose basename begins with `oldBase`, swapping
 * that prefix for `newBase` while preserving the trailing text and extension.
 * Related meeting artifacts are named off the note's basename — the transcript is
 * `<noteBase> - Transcript.md`, its audio `<noteBase> - Transcript.m4a`, and the
 * Tome sidecar `<noteBase> - Transcript.voiceprints.json` — so replacing the
 * leading `oldBase` keeps every artifact in lock-step with the note. Returns null
 * when the basename doesn't start with `oldBase` (leave that file untouched rather
 * than risk mangling an unrelated name).
 */
function relatedRenameTarget(file: TFile, oldBase: string, newBase: string): string | null {
	if (!file.basename.startsWith(oldBase)) return null;
	const suffix = file.basename.slice(oldBase.length);
	const newBasename = `${newBase}${suffix}`;
	const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
	const ext = file.extension ? `.${file.extension}` : "";
	return normalizePath(`${dir}${newBasename}${ext}`);
}

/**
 * Rename a meeting note (and optionally its related files) via Obsidian's
 * fileManager, which rewrites every wiki-link and frontmatter pointer across the
 * vault so the note↔transcript↔audio links survive the rename — no bespoke
 * link-fixing here. Collisions are checked up front so a clash surfaces before any
 * file is touched. Best-effort per related file (a Notice on failure) so one bad
 * rename doesn't strand the rest. Returns the count actually renamed.
 */
export async function renameMeetingFiles(
	app: App,
	note: TFile,
	newBase: string,
	related: readonly RelatedFile[],
): Promise<RenameMeetingResult> {
	const oldBase = note.basename;
	const dir = note.parent && note.parent.path !== "/" ? `${note.parent.path}/` : "";
	const notePath = normalizePath(`${dir}${newBase}.md`);

	// Resolve every intended target first, then guard against collisions before
	// mutating anything — a half-done rename would strand links mid-flight.
	const jobs: Array<{file: TFile; target: string}> = [{file: note, target: notePath}];
	for (const rf of related) {
		const target = relatedRenameTarget(rf.file, oldBase, newBase);
		if (target && target !== rf.file.path) jobs.push({file: rf.file, target});
	}

	for (const job of jobs) {
		if (job.target === job.file.path) continue;
		const existing = app.vault.getAbstractFileByPath(job.target);
		if (existing && existing !== job.file) {
			new Notice(`Can't rename — "${job.target}" already exists`);
			return {renamed: 0};
		}
	}

	let renamed = 0;
	for (const job of jobs) {
		if (job.target === job.file.path) continue;
		try {
			await app.fileManager.renameFile(job.file, job.target);
			renamed++;
		} catch (err) {
			console.error(`[WhisperCal] Failed to rename ${job.file.path} → ${job.target}:`, err);
			new Notice(`Couldn't rename ${job.file.name} — see console`);
		}
	}
	return {renamed};
}
