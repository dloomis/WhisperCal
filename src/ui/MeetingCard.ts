import {App, TFile, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {NameInputModal} from "./NameInputModal";
import {formatTime} from "../utils/time";
import {resolveWikiLink} from "../utils/vault";
import {linkRecording} from "../services/LinkRecording";
import {summarizeJobs, speakerTagJobs} from "../state";

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

const stateLabels: Record<PillState, string> = {
	incomplete: "",
	complete: " (done)",
	disabled: " (locked)",
	running: " (running)",
};

function renderPill(container: HTMLElement, icon: string, label: string, state: PillState): HTMLButtonElement {
	const btn = container.createEl("button", {
		cls: `whisper-cal-pill whisper-cal-pill-${state}`,
		attr: {"aria-label": label + stateLabels[state]},
	});
	const iconEl = btn.createSpan({cls: "whisper-cal-pill-icon"});
	setIcon(iconEl, state === "complete" ? "check" : icon);
	btn.createSpan({cls: "whisper-cal-pill-label", text: label});
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

	// Time gutter — left column
	const notAccepted = event.responseStatus !== "accepted" && event.responseStatus !== "organizer";
	const gutterCls = notAccepted
		? "whisper-cal-card-gutter whisper-cal-card-gutter-tentative"
		: "whisper-cal-card-gutter";
	const gutter = card.createDiv({cls: gutterCls});
	if (event.isAllDay) {
		gutter.createDiv({cls: "whisper-cal-card-gutter-time", text: "All Day"});
	} else if (event.id === "unscheduled") {
		gutter.createDiv({cls: "whisper-cal-card-gutter-time", text: "Ad Hoc"});
	} else {
		const timeStr = formatTime(event.startTime, timezone); // e.g. "11:00 AM"
		const timeDiv = gutter.createDiv({cls: "whisper-cal-card-gutter-time"});
		const match = timeStr.match(/^(.+)\s+(AM|PM)$/i);
		if (match) {
			timeDiv.createSpan({text: match[1]! + " "});
			timeDiv.createSpan({cls: "whisper-cal-card-gutter-period", text: match[2]!});
		} else {
			timeDiv.textContent = timeStr;
		}
		// Duration below the time
		if (event.startTime.getTime() !== event.endTime.getTime()) {
			const durationMs = event.endTime.getTime() - event.startTime.getTime();
			const durationMin = Math.round(durationMs / 60_000);
			let durText: string;
			if (durationMin >= 60) {
				const hours = Math.floor(durationMin / 60);
				const mins = durationMin % 60;
				durText = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
			} else {
				durText = `${durationMin}m`;
			}
			gutter.createDiv({cls: "whisper-cal-card-gutter-duration", text: durText});
		}
	}

	if (event.isOrganizer) {
		const starEl = gutter.createDiv({cls: "whisper-cal-card-gutter-organizer"});
		setIcon(starEl, "star");
	}

	// Content — right column
	const content = card.createDiv({cls: "whisper-cal-card-content"});

	// Subject row: Meeting Name
	const subjectRow = content.createDiv({cls: "whisper-cal-card-subject-row"});
	subjectRow.createDiv({cls: "whisper-cal-card-subject", text: event.subject});

	// Metadata row: location + invitee count + duration
	const meta = content.createDiv({cls: "whisper-cal-card-meta"});

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
		attEl.createSpan({text: `${event.attendeeCount} attendee${event.attendeeCount === 1 ? "" : "s"}`});
	}

	// Actions row: workflow pills
	const actions = content.createDiv({cls: "whisper-cal-card-actions"});

	// Top-level unscheduled placeholder — just a Note pill, no state lookup
	if (event.id === "unscheduled") {
		const notePill = renderPill(actions, "file-text", "Note", "incomplete");
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
	// Resolve transcript path for job tracking
	const transcriptLink = noteFm["transcript"] as string | undefined;
	const transcriptFile = transcriptLink
		? resolveWikiLink(app, noteFm, "transcript", notePath)
		: null;
	const transcriptPath = transcriptFile?.path ?? "";
	if (transcriptPath) {
		card.dataset.transcriptPath = transcriptPath;
	}

	const speakersState: PillState = transcriptState !== "complete"
		? "disabled"
		: (pipelineState && pipelineState !== "titled") ? "complete"
		: speakerTagJobs.has(transcriptPath) ? "running"
		: "incomplete";

	const summaryState: PillState = speakersState !== "complete"
		? "disabled"
		: pipelineState === "summarized" ? "complete"
		: summarizeJobs.has(notePath) ? "running"
		: "incomplete";

	// Highlight gutter when workflow is started but not yet complete
	if (noteExists && summaryState !== "complete") {
		gutter.addClass("whisper-cal-card-gutter-warning");
	}

	// Note pill
	const notePill = renderPill(actions, "file-text", "Note", noteState);
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
					if (onNoteCreated) {
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
	const transcriptPill = renderPill(actions, "mic", "Transcript", transcriptState);
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
	const speakersPill = renderPill(actions, "user", "Speakers", speakersState);
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
	const summaryPill = renderPill(actions, "sparkles", "Summary", summaryState);
	if (summaryState === "incomplete" && onSummarize) {
		summaryPill.addEventListener("click", () => {
			onSummarize(notePath);
		});
	} else if (summaryState === "complete") {
		summaryPill.addEventListener("click", () => {
			void app.workspace.openLinkText(notePath, "", false);
		});
	}

	// Status lines below actions
	if (speakersState === "running") {
		const status = content.createDiv({cls: "whisper-cal-card-status"});
		status.createSpan({cls: "whisper-cal-card-status-dot"});
		status.createSpan({text: "Tagging speakers\u2026"});
	}
	if (summaryState === "running") {
		const status = content.createDiv({cls: "whisper-cal-card-status"});
		status.createSpan({cls: "whisper-cal-card-status-dot"});
		status.createSpan({text: "Summarizing\u2026"});
	}

	return {el: card};
}
