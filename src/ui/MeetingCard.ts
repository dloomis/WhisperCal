import {App, TFile, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {formatTime} from "../utils/time";
import {linkRecording} from "../services/LinkRecording";

export interface MeetingCardHandle {
	el: HTMLElement;
}

export interface MeetingCardOpts {
	event: CalendarEvent;
	timezone: string;
	noteCreator: NoteCreator;
	app: App;
	isActive?: boolean;
	transcriptFolderPath?: string;
	recordingWindowMinutes?: number;
	onNoteCreated?: () => void;
	onTagSpeakers?: (transcriptFile: TFile, transcriptFm: Record<string, unknown>) => void;
}

type PillState = "incomplete" | "complete" | "disabled";

function resolveTranscriptFile(app: App, notePath: string, fm: Record<string, unknown>): TFile | null {
	const raw = fm["transcript"];
	if (!raw || typeof raw !== "string" || !raw.trim()) return null;
	const linktext = raw.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
	return app.metadataCache.getFirstLinkpathDest(linktext, notePath);
}

function renderPill(container: HTMLElement, label: string, state: PillState): HTMLButtonElement {
	const btn = container.createEl("button", {
		cls: `whisper-cal-pill whisper-cal-pill-${state}`,
	});
	if (state === "complete") {
		btn.createSpan({cls: "whisper-cal-pill-check", text: "✓"});
	}
	btn.createSpan({text: label});
	if (state === "disabled") {
		btn.disabled = true;
	}
	return btn;
}

export function renderMeetingCard(
	container: HTMLElement,
	opts: MeetingCardOpts,
): MeetingCardHandle {
	const {
		event, timezone, noteCreator, app,
		transcriptFolderPath = "Transcripts",
		recordingWindowMinutes = 10,
		onNoteCreated, onTagSpeakers,
	} = opts;
	const isActive = opts.isActive ?? false;

	const cls = isActive ? "whisper-cal-card whisper-cal-card-active" : "whisper-cal-card";
	const card = container.createDiv({cls});
	card.dataset.notePath = noteCreator.getNotePath(event);

	// Subject row: Meeting Name
	const subjectRow = card.createDiv({cls: "whisper-cal-card-subject-row"});
	subjectRow.createDiv({cls: "whisper-cal-card-subject", text: event.subject});

	// Time row
	const timeRow = card.createDiv({cls: "whisper-cal-card-time-row"});
	const timeEl = timeRow.createDiv({cls: "whisper-cal-card-time"});
	if (event.isAllDay) {
		timeEl.setText("All day");
	} else if (event.id === "unscheduled") {
		// Top-level unscheduled card — no time yet
		timeEl.setText("Ad hoc");
	} else if (event.startTime.getTime() === event.endTime.getTime()) {
		// Same start/end (e.g. unscheduled note with only a start time)
		const start = formatTime(event.startTime, timezone);
		timeEl.setText(start);
	} else {
		const start = formatTime(event.startTime, timezone);
		const end = formatTime(event.endTime, timezone);
		timeEl.setText(`${start} - ${end}`);
	}

	// Metadata row: location + invitee count
	const meta = card.createDiv({cls: "whisper-cal-card-meta"});

	if (event.onlineMeetingUrl) {
		const joinUrl = event.onlineMeetingUrl;
		const locLink = meta.createSpan({
			cls: "whisper-cal-card-meta-item whisper-cal-card-meta-link",
			attr: {"aria-label": "Join online meeting"},
		});
		locLink.addEventListener("click", (e) => {
			e.preventDefault();
			window.open(joinUrl, "_blank", "noopener");
		});
		const locIcon = locLink.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(locIcon, "map-pin");
		locLink.createSpan({text: event.location || "No location"});
	} else {
		const locEl = meta.createSpan({cls: "whisper-cal-card-meta-item"});
		const locIcon = locEl.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(locIcon, "map-pin");
		locEl.createSpan({text: event.location || "No location"});
	}

	if (event.attendeeCount > 0) {
		const attEl = meta.createSpan({cls: "whisper-cal-card-meta-item"});
		const attIcon = attEl.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(attIcon, "users");
		attEl.createSpan({text: String(event.attendeeCount)});
	}

	// Actions row: workflow pills
	const actions = card.createDiv({cls: "whisper-cal-card-actions"});

	// Read meeting note frontmatter for state detection
	const notePath = noteCreator.getNotePath(event);
	const noteAbstract = app.vault.getAbstractFileByPath(notePath);
	const noteFile = noteAbstract instanceof TFile ? noteAbstract : null;
	const noteExists = noteFile !== null;
	const noteFm: Record<string, unknown> = noteFile
		? (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {})
		: {};

	// Compute pill states
	const noteState: PillState = noteExists ? "complete" : "incomplete";

	const transcriptState: PillState = !noteExists
		? "disabled"
		: noteFm["transcript"] ? "complete" : "incomplete";

	const pipelineState = noteFm["pipeline_state"] as string | undefined;
	const speakersState: PillState = transcriptState !== "complete"
		? "disabled"
		: (pipelineState && pipelineState !== "titled") ? "complete" : "incomplete";

	const summaryState: PillState = "disabled";

	// Note pill
	const notePill = renderPill(actions, "Note", noteState);
	notePill.addEventListener("click", () => {
		notePill.disabled = true;
		const handleClick = async () => {
			try {
				if (noteCreator.noteExists(event)) {
					await noteCreator.openExistingNote(event);
				} else {
					const isUnscheduled = event.id === "unscheduled";
					await noteCreator.createNote(event);
					if (isUnscheduled && onNoteCreated) {
						onNoteCreated();
					}
				}
			} finally {
				notePill.disabled = false;
			}
		};
		void handleClick();
	});

	// For the top-level unscheduled placeholder, only show the Note pill
	if (event.id === "unscheduled") {
		return {el: card};
	}

	// Transcript pill
	const transcriptPill = renderPill(actions, "Transcript", transcriptState);
	if (transcriptState !== "disabled") {
		transcriptPill.addEventListener("click", () => {
			if (transcriptState === "complete") {
				// Open transcript file
				const tf = resolveTranscriptFile(app, notePath, noteFm);
				if (tf) {
					void app.workspace.openLinkText(tf.path, "", false);
				}
				return;
			}
			// Link recording (create note first if needed)
			transcriptPill.disabled = true;
			const handleMic = async () => {
				let linked = false;
				try {
					if (!(app.vault.getAbstractFileByPath(notePath) instanceof TFile)) {
						await noteCreator.createNote(event);
					}
					const isUnscheduled = event.id.startsWith("unscheduled");
					linked = await linkRecording({
						app,
						meetingStart: event.startTime,
						notePath,
						subject: event.subject,
						timezone,
						transcriptFolderPath,
						attendees: event.attendees,
						isRecurring: event.isRecurring,
						windowMinutes: isUnscheduled ? 720 : recordingWindowMinutes,
					});
				} finally {
					if (!linked) transcriptPill.disabled = false;
				}
			};
			void handleMic();
		});
	}

	// Speakers pill
	const speakersPill = renderPill(actions, "Speakers", speakersState);
	if (speakersState === "incomplete" && onTagSpeakers) {
		speakersPill.addEventListener("click", () => {
			const tf = resolveTranscriptFile(app, notePath, noteFm);
			if (!tf) return;
			const transcriptFm = app.metadataCache.getFileCache(tf)?.frontmatter ?? {};
			onTagSpeakers(tf, transcriptFm as Record<string, unknown>);
		});
	} else if (speakersState === "complete") {
		speakersPill.addEventListener("click", () => {
			const tf = resolveTranscriptFile(app, notePath, noteFm);
			if (tf) {
				void app.workspace.openLinkText(tf.path, "", false);
			}
		});
	}

	// Summary pill (always disabled)
	renderPill(actions, "Summary", summaryState);

	return {el: card};
}
