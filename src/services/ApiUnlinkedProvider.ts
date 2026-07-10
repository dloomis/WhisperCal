import type {App} from "obsidian";
import {TFile, TFolder, normalizePath} from "obsidian";
import type {UnlinkedRecording, UnlinkedRecordingProvider, LinkUnlinkedOpts} from "./UnlinkedRecordingProvider";
import type {WhisperCalSettings} from "../settings";
import {resolveWikiLink, resolveTranscriptAudio, stripWikiLink} from "../utils/vault";
import {batchUpdateFrontmatter} from "../utils/frontmatter";
import {parseDisplayName} from "../utils/nameParser";
import {parseDurationSeconds} from "../utils/time";
import {FM} from "../constants";

interface ApiTranscriptData {
	file: TFile;
}

/**
 * Retry an async rename up to 3 times, 500 ms apart. On Windows, Tome may still
 * hold a handle to a just-finished recording, making rename throw EBUSY/EPERM
 * transiently; the short retry lets the handle release so the audio/sidecar
 * basename heals instead of staying mismatched. Rethrows the last error so the
 * caller's existing best-effort catch/log path still runs.
 */
async function retryRename<T>(op: () => Promise<T>): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await op();
		} catch (err) {
			lastErr = err;
			if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
		}
	}
	throw lastErr;
}

export class ApiUnlinkedProvider implements UnlinkedRecordingProvider {
	readonly displayName = "Recording API";

	constructor(
		private app: App,
		private settings: WhisperCalSettings,
	) {}

	async findUnlinked(lookbackDays: number): Promise<UnlinkedRecording[]> {
		const folder = this.app.vault.getAbstractFileByPath(
			this.settings.transcriptFolderPath,
		);
		if (!(folder instanceof TFolder)) return [];

		const cutoff = Date.now() - lookbackDays * 86_400_000;
		const results: UnlinkedRecording[] = [];

		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			if (child.stat.ctime < cutoff) continue;

			const cache = this.app.metadataCache.getFileCache(child);
			const fm = cache?.frontmatter;
			if (!fm) continue;

			// Skip MacWhisper-owned transcripts — they belong to that provider
			if (fm[FM.MACWHISPER_SESSION_ID]) continue;

			// Linked if meeting_note resolves to an existing file
			const meetingFile = resolveWikiLink(
				this.app, fm as Record<string, unknown>,
				FM.MEETING_NOTE, child.path,
			);
			if (meetingFile) continue;

			results.push(this.toUnlinked(child, fm as Record<string, unknown>));
		}

		return results;
	}

	async linkToNote(opts: LinkUnlinkedOpts): Promise<boolean> {
		const data = opts.recording.providerData as ApiTranscriptData;

		// Re-resolve in case file was moved/deleted since findUnlinked()
		const freshFile = this.app.vault.getAbstractFileByPath(data.file.path);
		if (!(freshFile instanceof TFile)) return false;

		const noteBasename = opts.notePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
		if (!noteBasename) {
			console.error(`[WhisperCal] ApiUnlinkedProvider.linkToNote: empty noteBasename from "${opts.notePath}" — cannot link ${freshFile.path}`);
			return false;
		}

		// Capture the transcript's ORIGINAL frontmatter before enrichment rewrites it.
		// The `recording:`/`voiceprints:` pointers Tome wrote here name the sibling audio
		// and sidecar after the original recording; we need them to follow the rename below.
		const originalFm = (this.app.metadataCache.getFileCache(freshFile)?.frontmatter ?? {}) as Record<string, unknown>;

		// Read meeting note frontmatter for wiki-link invitees + calendar context
		const noteFile = opts.app.vault.getAbstractFileByPath(opts.notePath);
		const noteFm = (noteFile instanceof TFile)
			? this.app.metadataCache.getFileCache(noteFile)?.frontmatter
			: undefined;

		// 1. Enrich transcript frontmatter with full meeting context
		try {
			await this.app.fileManager.processFrontMatter(
				freshFile,
				(fm: Record<string, unknown>) => {
					const existing = Array.isArray(fm["tags"])
						? fm["tags"] as string[] : [];
					if (!existing.includes("transcript")) {
						fm["tags"] = [...existing, "transcript"];
					}
					fm[FM.MEETING_NOTE] = `[[${noteBasename}]]`;
					fm[FM.PIPELINE_STATE] = "titled";
					fm["meeting_subject"] = opts.subject;
					fm["is_recurring"] = opts.isRecurring ?? false;
					// Prefer wiki-link invitees from meeting note, fall back to plain names
					const wikiInvitees = Array.isArray(noteFm?.[FM.MEETING_INVITEES])
						? noteFm[FM.MEETING_INVITEES] as string[]
						: null;
					if (wikiInvitees && wikiInvitees.length > 0) {
						fm[FM.MEETING_INVITEES] = wikiInvitees;
					} else if (opts.attendees && opts.attendees.length > 0) {
						fm[FM.MEETING_INVITEES] = opts.attendees.map(
							a => parseDisplayName(a.name, a.email),
						);
					}
					// Calendar event context — makes transcript self-contained for LLM use
					if (opts.meetingDate) fm["meeting_date"] = opts.meetingDate;
					if (opts.meetingStart) fm["meeting_start"] = opts.meetingStart;
					if (opts.meetingEnd) fm["meeting_end"] = opts.meetingEnd;
					if (opts.organizer) fm["meeting_organizer"] = opts.organizer;
					if (opts.location) fm["meeting_location"] = opts.location;
				},
			);
		} catch (err) {
			console.error(`[WhisperCal] ApiUnlinkedProvider: failed to enrich ${freshFile.path} with meeting_note/context — aborting link:`, err);
			return false;
		}

		// 2. Rename transcript to match linked naming convention: "{noteBasename} - Transcript.md",
		//    bringing its sibling audio (.m4a) and voiceprint sidecar (.voiceprints.json) along so
		//    all three keep the same basename. Both companions are resolved by the transcript's
		//    basename as a fallback (resolveTranscriptAudio / loadSidecar), so leaving them behind
		//    orphans click-to-play audio and breaks acoustic enrollment.
		const expectedBasename = `${noteBasename} - Transcript`;
		const expectedPath = normalizePath(`${opts.transcriptFolderPath}/${expectedBasename}.md`);
		let transcriptFile: TFile = freshFile;
		if (freshFile.path !== expectedPath) {
			// Resolve companions while the transcript still carries its original name.
			const audioFile = resolveTranscriptAudio(this.app, freshFile, originalFm);
			const sidecarPath = await this.resolveSidecarPath(freshFile, originalFm);

			await this.app.fileManager.renameFile(freshFile, expectedPath);
			const renamed = this.app.vault.getAbstractFileByPath(expectedPath);
			if (renamed instanceof TFile) transcriptFile = renamed;

			// Best-effort: a missing or unrenameable companion never fails the link.
			await this.renameAudio(audioFile, expectedBasename);
			await this.renameSidecar(transcriptFile, sidecarPath, expectedBasename);
		}

		// 3. Link transcript on the meeting note side
		await batchUpdateFrontmatter(opts.app, opts.notePath, {
			[FM.TRANSCRIPT]: `[[${transcriptFile.basename}]]`,
			[FM.PIPELINE_STATE]: "titled",
		});

		return true;
	}

	isNoteLinked(fm: Record<string, unknown>): boolean {
		return !!fm[FM.TRANSCRIPT];
	}

	/**
	 * Locate the transcript's voiceprint sidecar on disk, mirroring loadSidecar's
	 * resolution order: the `voiceprints:` pointer (wiki-link, then bare filename
	 * relative to the transcript's folder / vault root), then the sibling convention
	 * `<transcript-basename>.voiceprints.json`. Returns the first path that exists.
	 */
	private async resolveSidecarPath(file: TFile, fm: Record<string, unknown>): Promise<string | null> {
		const candidates: string[] = [];
		const linked = resolveWikiLink(this.app, fm, FM.VOICEPRINTS, file.path);
		if (linked) candidates.push(linked.path);
		const raw = fm[FM.VOICEPRINTS];
		if (typeof raw === "string" && raw.trim()) {
			const name = stripWikiLink(raw);
			const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
			if (dir) candidates.push(normalizePath(`${dir}/${name}`));
			candidates.push(name);
		}
		candidates.push(file.path.replace(/\.md$/, ".voiceprints.json"));
		for (const path of candidates) {
			try {
				// Adapter API on purpose: the sidecar is written by Tome outside
				// Obsidian and may not be in the vault index yet, so vault lookups
				// would miss a just-created file.
				if (await this.app.vault.adapter.exists(path)) return path;
			} catch { /* try the next candidate */ }
		}
		return null;
	}

	/**
	 * Rename the audio recording to `<newBasename>.<ext>`, keeping it in its own folder
	 * (Tome may store audio outside the transcript folder). renameFile updates the
	 * transcript's `recording:` wiki-link automatically. Best-effort — never throws.
	 */
	private async renameAudio(audioFile: TFile | null, newBasename: string): Promise<void> {
		if (!audioFile) return;
		const dir = audioFile.path.includes("/") ? audioFile.path.slice(0, audioFile.path.lastIndexOf("/")) : "";
		const target = normalizePath(dir ? `${dir}/${newBasename}.${audioFile.extension}` : `${newBasename}.${audioFile.extension}`);
		if (audioFile.path === target) return;
		try {
			await retryRename(() => this.app.fileManager.renameFile(audioFile, target));
		} catch (err) {
			console.error(`[WhisperCal] Failed to rename recording ${audioFile.path} -> ${target} (transcript linked, audio left behind):`, err);
		}
	}

	/**
	 * Rename the voiceprint sidecar to `<newBasename>.voiceprints.json` (kept in its own
	 * folder) and repoint the transcript's `voiceprints:` frontmatter at it. The pointer
	 * is a `.json` path Obsidian's link index doesn't track, so renameFile can't
	 * update it — we rewrite it here. Best-effort — never throws.
	 */
	private async renameSidecar(transcriptFile: TFile, sidecarPath: string | null, newBasename: string): Promise<void> {
		if (!sidecarPath) return;
		const dir = sidecarPath.includes("/") ? sidecarPath.slice(0, sidecarPath.lastIndexOf("/")) : "";
		const targetName = `${newBasename}.voiceprints.json`;
		const target = normalizePath(dir ? `${dir}/${targetName}` : targetName);
		if (sidecarPath === target) return;
		try {
			const existing = this.app.vault.getAbstractFileByPath(sidecarPath);
			if (existing instanceof TFile) {
				await retryRename(() => this.app.fileManager.renameFile(existing, target));
			} else {
				await retryRename(() => this.app.vault.adapter.rename(sidecarPath, target));
			}
		} catch (err) {
			console.error(`[WhisperCal] Failed to rename voiceprint sidecar ${sidecarPath} -> ${target}:`, err);
			return;
		}
		try {
			await this.app.fileManager.processFrontMatter(transcriptFile, (fm: Record<string, unknown>) => {
				// Vault-relative path, not the bare filename: loadSidecar resolves a
				// bare name only against the transcript's folder and vault root, so a
				// sidecar kept in another folder (Tome stores it next to the audio)
				// would become unreachable. The full path always resolves via the
				// vault-root candidate.
				fm[FM.VOICEPRINTS] = target;
			});
		} catch (err) {
			console.error(`[WhisperCal] Renamed voiceprint sidecar but failed to update pointer on ${transcriptFile.path}:`, err);
		}
	}

	private toUnlinked(file: TFile, fm: Record<string, unknown>): UnlinkedRecording {
		let title = file.basename;
		if (title.endsWith(" - Transcript")) {
			title = title.slice(0, -" - Transcript".length);
		}

		let recordingStart: Date;
		const fmDate = fm["date"];
		if (fmDate instanceof Date) {
			recordingStart = fmDate;
		} else if (typeof fmDate === "string") {
			const parsed = new Date(fmDate);
			recordingStart = isNaN(parsed.getTime())
				? new Date(file.stat.ctime) : parsed;
		} else {
			recordingStart = new Date(file.stat.ctime);
		}

		const durationSeconds = parseDurationSeconds(fm["duration"]);

		let speakerCount = 0;
		if (typeof fm["speaker_count"] === "number") {
			speakerCount = fm["speaker_count"];
		} else if (Array.isArray(fm["speakers"])) {
			speakerCount = fm["speakers"].length;
		} else if (Array.isArray(fm["attendees"])) {
			// Third-party apps may use "attendees" instead of "speakers"
			speakerCount = fm["attendees"].length;
		}

		return {
			id: file.path,
			title,
			recordingStart,
			durationSeconds,
			speakerCount,
			transcriptPath: file.path,
			providerData: {file} as ApiTranscriptData,
		};
	}
}
