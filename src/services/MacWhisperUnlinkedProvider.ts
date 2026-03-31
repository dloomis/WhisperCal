import type {App} from "obsidian";
import type {UnlinkedRecording, UnlinkedRecordingProvider, LinkUnlinkedOpts} from "./UnlinkedRecordingProvider";
import {findRecentSessions, type MacWhisperRecording} from "./MacWhisperDb";
import {linkKnownRecording} from "./LinkRecording";
import {getLinkedSessionIds} from "../utils/vault";

export class MacWhisperUnlinkedProvider implements UnlinkedRecordingProvider {
	readonly displayName = "MacWhisper";

	constructor(private app: App) {}

	async findUnlinked(lookbackDays: number): Promise<UnlinkedRecording[]> {
		const sessions = await findRecentSessions(lookbackDays);
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
		return !!fm["macwhisper_session_id"];
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
