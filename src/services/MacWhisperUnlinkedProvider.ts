import type {App} from "obsidian";
import type {UnlinkedRecording, UnlinkedRecordingProvider, LinkUnlinkedOpts} from "./UnlinkedRecordingProvider";
import {findRecentSessions, MacWhisperDbError, type MacWhisperRecording} from "./MacWhisperDb";
import {linkKnownRecording} from "./LinkRecording";
import {getLinkedSessionIds} from "../utils/vault";
import {FM} from "../constants";

export class MacWhisperUnlinkedProvider implements UnlinkedRecordingProvider {
	readonly displayName = "MacWhisper";

	constructor(private app: App) {}

	async findUnlinked(lookbackDays: number): Promise<UnlinkedRecording[]> {
		// This is a passive background list; a transient DB read error (locked file)
		// shouldn't spam a Notice or break the section — log and show nothing.
		let sessions: MacWhisperRecording[];
		try {
			sessions = await findRecentSessions(lookbackDays);
		} catch (err) {
			if (err instanceof MacWhisperDbError) {
				console.warn("[WhisperCal]", err.message, err.detail);
				return [];
			}
			throw err;
		}
		const linked = getLinkedSessionIds(this.app);
		return sessions
			.filter(s => !linked.has(s.sessionId))
			.map(s => this.toUnlinked(s));
	}

	async linkToNote(opts: LinkUnlinkedOpts): Promise<boolean> {
		const session = opts.recording.providerData as MacWhisperRecording;
		return linkKnownRecording({
			app: opts.app,
			session,
			notePath: opts.notePath,
			subject: opts.subject,
			timezone: opts.timezone,
			transcriptFolderPath: opts.transcriptFolderPath,
			attendees: opts.attendees,
			isRecurring: opts.isRecurring,
		});
	}

	isNoteLinked(fm: Record<string, unknown>): boolean {
		return !!fm[FM.MACWHISPER_SESSION_ID];
	}

	private toUnlinked(s: MacWhisperRecording): UnlinkedRecording {
		return {
			id: s.sessionId,
			title: s.title ?? "Untitled recording",
			recordingStart: s.recordingStart,
			durationSeconds: s.durationSeconds,
			speakerCount: s.speakerCount,
			providerData: s,
		};
	}
}
