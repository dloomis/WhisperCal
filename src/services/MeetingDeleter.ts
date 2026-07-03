import {App, Notice, TFile} from "obsidian";
import {FM} from "../constants";
import {resolveWikiLink, resolveTranscriptAudio, resolveVoiceprintSidecar} from "../utils/vault";

export type RelatedFileKind = "transcript" | "audio" | "voiceprints";

export interface RelatedFile {
	file: TFile;
	kind: RelatedFileKind;
}

/**
 * Resolve the on-disk artifacts that belong to a single meeting: its linked
 * transcript, that transcript's source audio, and the transcript's Tome voiceprint
 * sidecar. Deliberately EXCLUDES the enrolled voiceprint libraries
 * (Caches/Voiceprints/<Name>.json) — those are per-person and shared across every
 * meeting, so deleting one meeting must never touch them. Deduped by path; the
 * meeting note itself is never included (the caller deletes it separately).
 */
export function collectMeetingRelatedFiles(
	app: App,
	notePath: string,
	noteFm: Record<string, unknown>,
): RelatedFile[] {
	const out: RelatedFile[] = [];
	const seen = new Set<string>();
	const add = (file: TFile | null, kind: RelatedFileKind): void => {
		if (!file || file.path === notePath || seen.has(file.path)) return;
		seen.add(file.path);
		out.push({file, kind});
	};

	const transcriptFile = resolveWikiLink(app, noteFm, FM.TRANSCRIPT, notePath);
	if (transcriptFile) {
		add(transcriptFile, "transcript");
		const transcriptFm = (app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {}) as Record<string, unknown>;
		add(resolveTranscriptAudio(app, transcriptFile, transcriptFm), "audio");
		add(resolveVoiceprintSidecar(app, transcriptFile, transcriptFm), "voiceprints");
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
