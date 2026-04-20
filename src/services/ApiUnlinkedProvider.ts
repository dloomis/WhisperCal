import type {App} from "obsidian";
import {TFile, TFolder, normalizePath} from "obsidian";
import type {UnlinkedRecording, UnlinkedRecordingProvider, LinkUnlinkedOpts} from "./UnlinkedRecordingProvider";
import type {WhisperCalSettings} from "../settings";
import {resolveWikiLink} from "../utils/vault";
import {batchUpdateFrontmatter} from "../utils/frontmatter";
import {parseDisplayName} from "../utils/nameParser";

/** Parse duration from number (seconds) or string ("MM:SS" / "HH:MM:SS"). */
function parseDuration(raw: unknown): number {
	if (typeof raw === "number") return raw;
	if (typeof raw !== "string") return 0;
	const parts = raw.split(":").map(Number);
	if (parts.some(isNaN)) return 0;
	if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
	if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
	return 0;
}

interface ApiTranscriptData {
	file: TFile;
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
			if (fm["macwhisper_session_id"]) continue;

			// Linked if meeting_note resolves to an existing file
			const meetingFile = resolveWikiLink(
				this.app, fm as Record<string, unknown>,
				"meeting_note", child.path,
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
					fm["meeting_note"] = `[[${noteBasename}]]`;
					fm["pipeline_state"] = "titled";
					fm["meeting_subject"] = opts.subject;
					fm["is_recurring"] = opts.isRecurring ?? false;
					// Prefer wiki-link invitees from meeting note, fall back to plain names
					const wikiInvitees = Array.isArray(noteFm?.["meeting_invitees"])
						? noteFm["meeting_invitees"] as string[]
						: null;
					if (wikiInvitees && wikiInvitees.length > 0) {
						fm["meeting_invitees"] = wikiInvitees;
					} else if (opts.attendees && opts.attendees.length > 0) {
						fm["meeting_invitees"] = opts.attendees.map(
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

		// 2. Rename transcript to match linked naming convention: "{noteBasename} - Transcript.md"
		const expectedName = `${noteBasename} - Transcript.md`;
		const expectedPath = normalizePath(`${opts.transcriptFolderPath}/${expectedName}`);
		let transcriptFile: TFile = freshFile;
		if (freshFile.path !== expectedPath) {
			await this.app.fileManager.renameFile(freshFile, expectedPath);
			const renamed = this.app.vault.getAbstractFileByPath(expectedPath);
			if (renamed instanceof TFile) transcriptFile = renamed;
		}

		// 3. Link transcript on the meeting note side
		await batchUpdateFrontmatter(opts.app, opts.notePath, {
			transcript: `[[${transcriptFile.basename}]]`,
			pipeline_state: "titled",
		});

		return true;
	}

	isNoteLinked(fm: Record<string, unknown>): boolean {
		return !!fm["transcript"];
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

		const durationSeconds = parseDuration(fm["duration"]);

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
