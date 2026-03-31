import type {App} from "obsidian";
import {TFile, TFolder} from "obsidian";
import type {UnlinkedRecording, UnlinkedRecordingProvider, LinkUnlinkedOpts} from "./UnlinkedRecordingProvider";
import type {WhisperCalSettings} from "../settings";
import {resolveWikiLink} from "../utils/vault";
import {batchUpdateFrontmatter} from "../utils/frontmatter";
import {parseDisplayName} from "../utils/nameParser";

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

		// 1. Enrich transcript frontmatter
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
				if (opts.attendees && opts.attendees.length > 0) {
					fm["meeting_invitees"] = opts.attendees.map(
						a => parseDisplayName(a.name, a.email),
					);
				}
			},
		);

		// 2. Link transcript on the meeting note side
		const transcriptBasename = freshFile.basename;
		await batchUpdateFrontmatter(opts.app, opts.notePath, {
			transcript: `[[${transcriptBasename}]]`,
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

		const durationSeconds = typeof fm["duration"] === "number"
			? fm["duration"] : 0;

		let speakerCount = 0;
		if (typeof fm["speaker_count"] === "number") {
			speakerCount = fm["speaker_count"];
		} else if (Array.isArray(fm["speakers"])) {
			speakerCount = fm["speakers"].length;
		}

		return {
			id: file.path,
			title,
			recordingStart,
			durationSeconds,
			speakerCount,
			providerData: {file} as ApiTranscriptData,
		};
	}
}
