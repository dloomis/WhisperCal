import {App, TFile, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {NameInputModal} from "./NameInputModal";
import {formatTime} from "../utils/time";
import {resolveWikiLink} from "../utils/vault";
import {linkRecording} from "../services/LinkRecording";
import {updateFrontmatter} from "../utils/frontmatter";
import {summarizeJobs, speakerTagJobs} from "../state";

export interface MeetingCardOpts {
	event: CalendarEvent;
	timezone: string;
	noteCreator: NoteCreator;
	app: App;
	transcriptFolderPath?: string;
	recordingWindowMinutes?: number;
	onNoteCreated?: (eventId: string) => void;
	importantOrganizerEmails?: readonly string[];
	llmEnabled?: boolean;
	onTagSpeakers?: (transcriptFile: TFile, transcriptFm: Record<string, unknown>) => void;
	onSummarize?: (notePath: string) => void;
}

type PillState = "incomplete" | "complete" | "disabled" | "running";

interface PillStates {
	note: PillState;
	transcript: PillState;
	speakers: PillState;
	summary: PillState;
	transcriptFile: TFile | null;
	transcriptPath: string;
	pipelineState: string | undefined;
}

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
	setIcon(iconEl, icon);
	if (state === "complete") {
		btn.createSpan({cls: "whisper-cal-pill-badge"});
	}
	if (state === "disabled" || state === "running") {
		btn.disabled = true;
	}
	return btn;
}

function renderGutter(card: HTMLElement, event: CalendarEvent, timezone: string, opts: MeetingCardOpts): HTMLElement {
	const notAccepted = event.responseStatus !== "accepted" && event.responseStatus !== "organizer";
	const gutterCls = notAccepted
		? "whisper-cal-card-gutter whisper-cal-card-gutter-tentative"
		: "whisper-cal-card-gutter";
	const gutter = card.createDiv({cls: gutterCls});

	// Category color is shown via the grid icon only; the vertical bar mirrors gutter state

	if (event.isAllDay) {
		gutter.createDiv({cls: "whisper-cal-card-gutter-time", text: "All Day"});
	} else if (event.id === "unscheduled") {
		gutter.createDiv({cls: "whisper-cal-card-gutter-time", text: "Ad Hoc"});
	} else {
		const timeStr = formatTime(event.startTime, timezone);
		const timeDiv = gutter.createDiv({cls: "whisper-cal-card-gutter-time"});
		const match = timeStr.match(/^(.+)\s+(AM|PM)$/i);
		if (match) {
			timeDiv.createSpan({text: match[1]! + " "});
			timeDiv.createSpan({cls: "whisper-cal-card-gutter-period", text: match[2]!});
		} else {
			timeDiv.textContent = timeStr;
		}
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

	const importantEmails = opts.importantOrganizerEmails ?? [];
	const isImportantOrganizer = importantEmails.length > 0
		&& event.organizerEmail
		&& importantEmails.includes(event.organizerEmail.toLowerCase());
	const hasCategory = event.categories.length > 0;
	const hasIcons = event.isOrganizer || isImportantOrganizer || hasCategory;

	if (hasIcons) {
		const iconRow = gutter.createDiv({cls: "whisper-cal-card-gutter-icons"});

		if (event.isOrganizer) {
			const starEl = iconRow.createDiv({cls: "whisper-cal-card-gutter-organizer", attr: {"aria-label": "You are the organizer"}});
			setIcon(starEl, "star");
		}

		if (isImportantOrganizer) {
			const importantEl = iconRow.createDiv({cls: "whisper-cal-card-gutter-important", attr: {"aria-label": "Important organizer"}});
			setIcon(importantEl, "octagon-alert");
		}

		if (hasCategory) {
			const catEl = iconRow.createDiv({
				cls: "whisper-cal-card-gutter-category",
				attr: {"aria-label": event.categories[0]!.name},
			});
			catEl.style.color = event.categories[0]!.color;
			setIcon(catEl, "square");
			const svg = catEl.querySelector("svg");
			if (svg) svg.style.fill = event.categories[0]!.color;
		}
	}

	return gutter;
}

function renderMetadata(content: HTMLElement, event: CalendarEvent): void {
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
		setIcon(attIcon, "users-round");
		attEl.createSpan({text: `${event.attendeeCount}`});
	}
}

function computePillStates(
	app: App,
	noteCreator: NoteCreator,
	event: CalendarEvent,
): PillStates {
	const noteFile = noteCreator.findNote(event);
	const notePath = noteFile ? noteFile.path : noteCreator.getNotePath(event);
	const noteExists = noteFile !== null;
	const noteFm: Record<string, unknown> = noteFile
		? (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {})
		: {};

	const note: PillState = noteExists ? "complete" : "incomplete";
	const transcript: PillState = !noteExists
		? "disabled"
		: noteFm["transcript"] ? "complete" : "incomplete";

	const pipelineState = noteFm["pipeline_state"] as string | undefined;
	const transcriptFile = noteFm["transcript"]
		? resolveWikiLink(app, noteFm, "transcript", notePath)
		: null;
	const transcriptPath = transcriptFile?.path ?? "";

	const speakers: PillState = transcript !== "complete"
		? "disabled"
		: (pipelineState && pipelineState !== "titled") ? "complete"
		: speakerTagJobs.has(transcriptPath) ? "running"
		: "incomplete";

	const summary: PillState = speakers !== "complete"
		? "disabled"
		: pipelineState === "summarized" ? "complete"
		: summarizeJobs.has(notePath) ? "running"
		: "incomplete";

	return {note, transcript, speakers, summary, transcriptFile, transcriptPath, pipelineState};
}

/**
 * If the meeting note is missing macwhisper_session_id but its linked
 * transcript still has one, copy it back to the note.
 */
async function healMissingSessionId(
	app: App,
	noteCreator: NoteCreator,
	event: CalendarEvent,
): Promise<void> {
	const noteFile = noteCreator.findNote(event);
	if (!noteFile) return;

	const noteFm = app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {};
	if (noteFm["macwhisper_session_id"]) return; // already present

	const transcriptFile = resolveWikiLink(app, noteFm, "transcript", noteFile.path);
	if (!transcriptFile) return;

	const transcriptFm = app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {};
	const sessionId = transcriptFm["macwhisper_session_id"] as string | undefined;
	if (!sessionId) return;

	await updateFrontmatter(app, noteFile.path, "macwhisper_session_id", sessionId);
	console.debug(`[WhisperCal] Healed macwhisper_session_id on ${noteFile.path} from transcript`);
}

export function renderMeetingCard(
	container: HTMLElement,
	opts: MeetingCardOpts,
): HTMLElement {
	const {
		event, timezone, noteCreator, app,
		transcriptFolderPath = "Transcripts",
		recordingWindowMinutes = 10,
		onNoteCreated, onTagSpeakers, onSummarize,
	} = opts;
	const card = container.createDiv({cls: "whisper-cal-card"});
	card.dataset.eventId = event.id;
	card.dataset.notePath = noteCreator.getNotePath(event);
	if (!event.isAllDay) {
		card.dataset.startTime = String(event.startTime.getTime());
		card.dataset.endTime = String(event.endTime.getTime());
	}

	const gutter = renderGutter(card, event, timezone, opts);
	const content = card.createDiv({cls: "whisper-cal-card-content"});

	// Subject
	const subjectRow = content.createDiv({cls: "whisper-cal-card-subject-row"});
	subjectRow.createDiv({cls: "whisper-cal-card-subject", text: event.subject});

	renderMetadata(content, event);

	// Actions row
	const actions = content.createDiv({cls: "whisper-cal-card-actions"});

	// Top-level unscheduled placeholder — just a Note pill, no state lookup
	if (event.id === "unscheduled") {
		const notePill = renderPill(actions, "file-plus-2", "Note", "incomplete");
		notePill.addEventListener("click", () => {
			notePill.disabled = true;
			const handleClick = async () => {
				try {
					const name = await new NameInputModal(app, {
						defaultValue: event.subject,
					}).prompt();
					if (!name) return;
					await noteCreator.createNote({...event, subject: name});
					if (onNoteCreated) onNoteCreated(event.id);
				} finally {
					notePill.disabled = false;
				}
			};
			void handleClick();
		});
		return card;
	}

	// Compute workflow pill states
	const states = computePillStates(app, noteCreator, event);
	const noteFile = noteCreator.findNote(event);
	const notePath = noteFile ? noteFile.path : noteCreator.getNotePath(event);
	const noteFm: Record<string, unknown> = noteFile
		? (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {})
		: {};

	if (states.transcriptPath) {
		card.dataset.transcriptPath = states.transcriptPath;
	}

	// Highlight gutter based on workflow progress
	if (states.summary === "complete") {
		gutter.addClass("whisper-cal-card-gutter-done");
	} else if (states.note === "complete") {
		gutter.addClass("whisper-cal-card-gutter-warning");
	}

	// Note pill
	const notePill = renderPill(actions, "file-plus-2", "Note", states.note);
	notePill.addEventListener("click", () => {
		notePill.disabled = true;
		const handleClick = async () => {
			try {
				if (noteCreator.noteExists(event)) {
					await healMissingSessionId(app, noteCreator, event);
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
					if (onNoteCreated) onNoteCreated(event.id);
				}
			} finally {
				notePill.disabled = false;
			}
		};
		void handleClick();
	});

	// Transcript pill
	const transcriptPill = renderPill(actions, "mic", "Transcript", states.transcript);
	if (states.transcript !== "disabled") {
		transcriptPill.addEventListener("click", () => {
			if (states.transcript === "complete") {
				const tf = resolveWikiLink(app, noteFm, "transcript", notePath);
				if (tf) void app.workspace.openLinkText(tf.path, "", false);
				return;
			}
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

	// Speakers pill (LLM feature)
	if (opts.llmEnabled !== false) {
		const speakersPill = renderPill(actions, "users-round", "Speakers", states.speakers);
		if (states.speakers === "incomplete" && onTagSpeakers) {
			speakersPill.addEventListener("click", () => {
				const tf = resolveWikiLink(app, noteFm, "transcript", notePath);
				if (!tf) return;
				const transcriptFm = app.metadataCache.getFileCache(tf)?.frontmatter ?? {};
				onTagSpeakers(tf, transcriptFm as Record<string, unknown>);
			});
		} else if (states.speakers === "complete") {
			speakersPill.addEventListener("click", () => {
				const tf = resolveWikiLink(app, noteFm, "transcript", notePath);
				if (tf) void app.workspace.openLinkText(tf.path, "", false);
			});
		}
	}

	// Summary pill (LLM feature)
	if (opts.llmEnabled !== false) {
		const summaryPill = renderPill(actions, "sparkles", "Summary", states.summary);
		if (states.summary === "incomplete" && onSummarize) {
			summaryPill.addEventListener("click", () => {
				onSummarize(notePath);
			});
		} else if (states.summary === "complete") {
			summaryPill.addEventListener("click", () => {
				void app.workspace.openLinkText(notePath, "", false);
			});
		}
	}

	// Status lines below actions
	if (opts.llmEnabled !== false && states.speakers === "running") {
		const status = content.createDiv({cls: "whisper-cal-card-status"});
		status.createSpan({cls: "whisper-cal-card-status-dot"});
		status.createSpan({text: "Tagging speakers\u2026"});
	}
	if (opts.llmEnabled !== false && states.summary === "running") {
		const status = content.createDiv({cls: "whisper-cal-card-status"});
		status.createSpan({cls: "whisper-cal-card-status-dot"});
		status.createSpan({text: "Summarizing\u2026"});
	}

	return card;
}
