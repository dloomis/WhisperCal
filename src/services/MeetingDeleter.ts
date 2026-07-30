import {App, Notice, TFile} from "obsidian";
import {FM} from "../constants";
import {resolveWikiLink, resolveTranscriptAudio, resolveVoiceprintSidecar} from "../utils/vault";

export type RelatedFileKind = "transcript" | "audio" | "voiceprints";

export interface RelatedFile {
	file: TFile;
	kind: RelatedFileKind;
}

/**
 * True when a markdown file other than `excludePath` still points at `targetPath`.
 *
 * Two independent checks, because either can miss on its own:
 *  - metadataCache.resolvedLinks covers body links and embeds (a merged
 *    transcript's `![[audio]]`), but only indexes frontmatter wikilinks on
 *    Obsidian versions that resolve them.
 *  - a direct sweep of the transcript's sibling folder re-resolves each
 *    transcript's `recording:` pointer, which is the exact shape a split's two
 *    halves share and the one case that must never be missed.
 */
function isSharedWithAnotherNote(app: App, target: TFile, excludePath: string): boolean {
	for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
		if (source === excludePath) continue;
		if (targets[target.path]) return true;
	}
	const siblings = app.vault.getAbstractFileByPath(excludePath)?.parent?.children ?? [];
	for (const sibling of siblings) {
		if (!(sibling instanceof TFile) || sibling.extension !== "md" || sibling.path === excludePath) continue;
		const fm = (app.metadataCache.getFileCache(sibling)?.frontmatter ?? {}) as Record<string, unknown>;
		if (resolveTranscriptAudio(app, sibling, fm)?.path === target.path) return true;
		if (resolveVoiceprintSidecar(app, sibling, fm)?.path === target.path) return true;
	}
	return false;
}

/**
 * Resolve a transcript's companion artifacts: its source audio and its Tome
 * voiceprint sidecar. Deliberately EXCLUDES the enrolled voiceprint libraries
 * (Caches/Voiceprints/<Name>.json) — those are per-person and shared across every
 * meeting, so deleting one transcript must never touch them. The transcript itself
 * is not included (the caller deletes it separately).
 *
 * Also excludes any companion that ANOTHER markdown file still points at. This is
 * what makes "Split transcript…" safe: the two halves of a split recording are
 * separate transcripts backed by the one `.m4a`, each carrying the same
 * `recording:` wikilink, so deleting one meeting must not take the other's audio
 * with it. (A merged transcript embedding a part's audio counts the same way.)
 * Each transcript still gets its own pruned voiceprint sidecar, so the sidecar
 * normally has exactly one linker and is included as before.
 */
export function collectTranscriptRelatedFiles(app: App, transcriptFile: TFile): RelatedFile[] {
	const out: RelatedFile[] = [];
	const seen = new Set<string>([transcriptFile.path]);
	const add = (file: TFile | null, kind: RelatedFileKind): void => {
		if (!file || seen.has(file.path)) return;
		seen.add(file.path);
		if (isSharedWithAnotherNote(app, file, transcriptFile.path)) {
			console.debug(`[WhisperCal] Keeping shared ${kind} ${file.path} — still referenced by another note`);
			return;
		}
		out.push({file, kind});
	};

	const transcriptFm = (app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {}) as Record<string, unknown>;
	add(resolveTranscriptAudio(app, transcriptFile, transcriptFm), "audio");
	add(resolveVoiceprintSidecar(app, transcriptFile, transcriptFm), "voiceprints");
	return out;
}

/**
 * Resolve the on-disk artifacts that belong to a single meeting: its linked
 * transcript plus that transcript's companions (see
 * `collectTranscriptRelatedFiles`). Deduped by path; the meeting note itself is
 * never included (the caller deletes it separately).
 */
export function collectMeetingRelatedFiles(
	app: App,
	notePath: string,
	noteFm: Record<string, unknown>,
): RelatedFile[] {
	const transcriptFile = resolveWikiLink(app, noteFm, FM.TRANSCRIPT, notePath);
	if (!transcriptFile || transcriptFile.path === notePath) return [];
	const out: RelatedFile[] = [{file: transcriptFile, kind: "transcript"}];
	for (const rf of collectTranscriptRelatedFiles(app, transcriptFile)) {
		if (rf.file.path !== notePath) out.push(rf);
	}
	return out;
}

/**
 * Move files to trash exactly the way Obsidian's own delete does — via
 * fileManager, which honors the user's "Files & Links → Deleted files" preference
 * (Obsidian .trash / system trash / permanent). That preference is what preserves
 * native recoverability, so there's no bespoke undo to maintain here. Best-effort
 * per file (a Notice on failure) so one bad file doesn't strand the rest. Returns
 * the number actually trashed.
 */
export async function trashMeetingFiles(app: App, files: TFile[]): Promise<number> {
	let trashed = 0;
	for (const file of files) {
		try {
			await app.fileManager.trashFile(file);
			trashed++;
		} catch (err) {
			console.error(`[WhisperCal] Failed to trash ${file.path}:`, err);
			new Notice(`Couldn't delete ${file.name} — see console`);
		}
	}
	return trashed;
}
