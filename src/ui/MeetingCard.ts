import {App, TFile, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {NameInputModal} from "./NameInputModal";
import {formatTime} from "../utils/time";
import {resolveWikiLink} from "../utils/vault";
import {linkRecording} from "../services/LinkRecording";
import {summarizeJobs} from "../state";

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
	onSummarize?: (notePath: string) => void;
}

type PillState = "incomplete" | "complete" | "disabled" | "running";

function renderPill(container: HTMLElement, label: string, state: PillState): HTMLButtonElement {
	const btn = container.createEl("button", {
		cls: `whisper-cal-pill whisper-cal-pill-${state}`,
	});
	if (state === "complete") {
		btn.createSpan({cls: "whisper-cal-pill-check", text: "✓"});
	}
	btn.createSpan({text: label});
	if (state === "disabled" || state === "running") {
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
		onNoteCreated, onTagSpeakers, onSummarize,
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

	// Top-level unscheduled placeholder — just a Note pill, no state lookup
	if (event.id === "unscheduled") {
		const notePill = renderPill(actions, "Note", "incomplete");
		notePill.addEventListener("click", () => {
			notePill.disabled = true;
			const handleClick = async () => {
				try {
					const name = await new NameInputModal(app, {
						defaultValue: event.subject,
					}).prompt();
					if (!name) return;
					await noteCreator.createNote({...event, subject: name});
					if (onNoteCreated) onNoteCreated();
				} finally {
					notePill.disabled = false;
				}
			};
			void handleClick();
		});
		return {el: card};
	}

	// Read meeting note frontmatter for state detection
	const noteFile = noteCreator.findNote(event);
	const notePath = noteFile ? noteFile.path : noteCreator.getNotePath(event);
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

	const summaryState: PillState = speakersState !== "complete"
		? "disabled"
		: pipelineState === "summarized" ? "complete"
		: summarizeJobs.has(notePath) ? "running"
		: "incomplete";

	// Highlight card when workflow is started but not yet complete
	if (noteExists && summaryState !== "complete") {
		card.addClass("whisper-cal-card-warning");
	}

	// Note pill
	const notePill = renderPill(actions, "Note", noteState);
	notePill.addEventListener("click", () => {
		notePill.disabled = true;
		const handleClick = async () => {
			try {
				if (noteCreator.noteExists(event)) {
					await noteCreator.openExistingNote(event);
				} else {
					const isUnscheduled = event.id.startsWith("unscheduled");
					let targetEvent = event;
					if (isUnscheduled) {
						const name = await new NameInputModal(app, {
							defaultValue: event.subject,
						}).prompt();
						if (!name) return;
						targetEvent = {...event, subject: name};
					}
					await noteCreator.createNote(targetEvent);
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

	// Transcript pill
	const transcriptPill = renderPill(actions, "Transcript", transcriptState);
	if (transcriptState !== "disabled") {
		transcriptPill.addEventListener("click", () => {
			if (transcriptState === "complete") {
				// Open transcript file
				const tf = resolveWikiLink(app, noteFm, "transcript", notePath);
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
			const tf = resolveWikiLink(app, noteFm, "transcript", notePath);
			if (!tf) return;
			const transcriptFm = app.metadataCache.getFileCache(tf)?.frontmatter ?? {};
			onTagSpeakers(tf, transcriptFm as Record<string, unknown>);
		});
	} else if (speakersState === "complete") {
		speakersPill.addEventListener("click", () => {
			const tf = resolveWikiLink(app, noteFm, "transcript", notePath);
			if (tf) {
				void app.workspace.openLinkText(tf.path, "", false);
			}
		});
	}

	// Summary pill
	const summaryPill = renderPill(actions, "Summary", summaryState);
	if (summaryState === "incomplete" && onSummarize) {
		summaryPill.addEventListener("click", () => {
			onSummarize(notePath);
		});
	} else if (summaryState === "complete") {
		summaryPill.addEventListener("click", () => {
			void app.workspace.openLinkText(notePath, "", false);
		});
	}

	// Status line below actions
	if (summaryState === "running") {
		const status = card.createDiv({cls: "whisper-cal-card-status"});
		status.createSpan({cls: "whisper-cal-card-status-dot"});
		status.createSpan({text: "Summarizing\u2026"});
	}

	return {el: card};
}
