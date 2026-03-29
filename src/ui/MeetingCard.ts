import {App, Notice, TFile, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {NameInputModal} from "./NameInputModal";
import {formatTime, formatRecordingDuration} from "../utils/time";
import {resolveWikiLink} from "../utils/vault";
import {linkRecording} from "../services/LinkRecording";
import {updateFrontmatter} from "../utils/frontmatter";
import {summarizeJobs, speakerTagJobs, researchJobs, tomeRecordingState} from "../state";
import type {PeopleMatchService} from "../services/PeopleMatchService";
import {startTomeRecording, stopTomeRecording, watchTomeRecording} from "../services/TomeRecording";

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
	onTagSpeakers?: (transcriptFile: TFile, transcriptFm: Record<string, unknown>, notePath: string) => void;
	onSummarize?: (notePath: string) => void;
	onResearch?: (notePath: string) => void;
	peopleMatchService?: PeopleMatchService;
	tomeEnabled?: boolean;
	speakerTagModel?: string;
	summarizerModel?: string;
	researchModel?: string;
}

/** Derive a short display name from a Claude model ID, e.g. "claude-opus-4-6" → "Opus 4.6" */
function formatModelName(modelId: string): string {
	if (!modelId) return "";
	const match = modelId.match(/^claude-(\w+)-(\d+)-(\d+)/);
	if (match) {
		const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
		return `${family} ${match[2]}.${match[3]}`;
	}
	return modelId;
}

type PillState = "incomplete" | "complete" | "disabled" | "running";

interface PillStates {
	note: PillState;
	research: PillState;
	transcript: PillState;
	tomeRecord: PillState;
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
	const notAccepted = !event.isOrganizer && event.responseStatus !== "accepted" && event.responseStatus !== "organizer";
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
			const durationSec = Math.round((event.endTime.getTime() - event.startTime.getTime()) / 1000);
			const durText = formatRecordingDuration(durationSec);
			if (durText) {
				gutter.createDiv({cls: "whisper-cal-card-gutter-duration", text: durText});
			}
		}
	}

	// Category → colored left border on the card
	if (event.categories.length > 0) {
		card.setCssProps({"--wc-cat-color": event.categories[0]!.color});
		card.addClass("whisper-cal-card-categorized");
	}

	const importantEmails = opts.importantOrganizerEmails ?? [];
	const isImportantOrganizer = importantEmails.length > 0
		&& event.organizerEmail
		&& importantEmails.includes(event.organizerEmail.toLowerCase());
	const hasIcons = event.isOrganizer || isImportantOrganizer;

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
	}

	return gutter;
}

function renderMetadata(content: HTMLElement, event: CalendarEvent): void {
	const meta = content.createDiv({cls: "whisper-cal-card-meta"});

	if (event.onlineMeetingUrl) {
		const joinUrl = event.onlineMeetingUrl;
		const locLink = meta.createEl("a", {
			cls: "whisper-cal-card-meta-item whisper-cal-card-meta-link",
			href: joinUrl,
			attr: {"aria-label": "Join online meeting", target: "_blank", rel: "noopener"},
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
	const research: PillState = !noteExists
		? "disabled"
		: researchJobs.has(notePath) ? "running"
		: noteFm["research_notes"] ? "complete"
		: "incomplete";
	const transcript: PillState = !noteExists
		? "disabled"
		: noteFm["transcript"] ? "complete" : "incomplete";

	const tomeRecord: PillState = tomeRecordingState.has(notePath)
		? "running"
		: noteFm["transcript"] ? "complete"
		: tomeRecordingState.size > 0 ? "disabled"
		: "incomplete";

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

	return {note, research, transcript, tomeRecord, speakers, summary, transcriptFile, transcriptPath, pipelineState};
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

/** Compact, read-only card for all-day calendar events. */
export function renderAllDayCard(
	container: HTMLElement,
	event: CalendarEvent,
	opts: {importantOrganizerEmails?: readonly string[]},
): HTMLElement {
	const card = container.createDiv({cls: "whisper-cal-card whisper-cal-card-allday"});
	card.dataset.eventId = event.id;

	// Thin color gutter
	const gutter = card.createDiv({cls: "whisper-cal-allday-gutter"});
	if (event.categories.length > 0) {
		gutter.setCssProps({"--wc-cat-color": event.categories[0]!.color});
		gutter.addClass("whisper-cal-allday-gutter-colored");
	}

	const content = card.createDiv({cls: "whisper-cal-allday-content"});

	// Subject + optional icons
	const row = content.createDiv({cls: "whisper-cal-allday-row"});
	row.createSpan({cls: "whisper-cal-allday-subject", text: event.subject});

	const importantEmails = opts.importantOrganizerEmails ?? [];
	const isImportantOrganizer = importantEmails.length > 0
		&& event.organizerEmail
		&& importantEmails.includes(event.organizerEmail.toLowerCase());

	if (event.isOrganizer || isImportantOrganizer) {
		const icons = row.createSpan({cls: "whisper-cal-allday-icons"});
		if (event.isOrganizer) {
			const el = icons.createSpan({cls: "whisper-cal-card-gutter-organizer", attr: {"aria-label": "You are the organizer"}});
			setIcon(el, "star");
		}
		if (isImportantOrganizer) {
			const el = icons.createSpan({cls: "whisper-cal-card-gutter-important", attr: {"aria-label": "Important organizer"}});
			setIcon(el, "octagon-alert");
		}
	}

	return card;
}

export function renderMeetingCard(
	container: HTMLElement,
	opts: MeetingCardOpts,
): HTMLElement {
	const {
		event, timezone, noteCreator, app,
		transcriptFolderPath = "Transcripts",
		recordingWindowMinutes = 10,
		onNoteCreated, onTagSpeakers, onSummarize, onResearch,
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

	// Organizer row
	if (event.organizerName) {
		const orgRow = content.createDiv({cls: "whisper-cal-card-meta"});
		const orgEl = orgRow.createSpan({cls: "whisper-cal-card-meta-item"});
		const orgIcon = orgEl.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(orgIcon, "user");

		const peopleMatch = opts.peopleMatchService
			? opts.peopleMatchService.matchOne(event.organizerName, event.organizerEmail)
			: null;

		if (peopleMatch) {
			const link = orgEl.createEl("a", {
				cls: "whisper-cal-card-meta-link",
				text: event.organizerName,
			});
			link.addEventListener("click", (e) => {
				e.preventDefault();
				void app.workspace.openLinkText(peopleMatch, "", false);
			});
		} else {
			orgEl.createSpan({text: event.organizerName});
		}
	}

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

	// Tome Record pill (right after Note, before Research)
	if (opts.tomeEnabled) {
		const recordPill = renderPill(actions, "circle", "Record", states.tomeRecord);
		recordPill.addClass("whisper-cal-pill-record");
		if (states.tomeRecord === "running") {
			recordPill.addClass("whisper-cal-pill-recording");
		}
		if (states.tomeRecord === "complete") {
			recordPill.addEventListener("click", () => {
				const tf = resolveWikiLink(app, noteFm, "transcript", notePath);
				if (tf) void app.workspace.openLinkText(tf.path, "", false);
			});
		} else if (states.tomeRecord === "running") {
			recordPill.disabled = false; // override — running pill is clickable to stop
			recordPill.addEventListener("click", () => {
				recordPill.disabled = true;
				recordPill.removeClass("whisper-cal-pill-recording");
				void stopTomeRecording({app, notePath, transcriptFolderPath});
			});
		} else if (states.tomeRecord === "incomplete") {
			let recording = false;
			recordPill.addEventListener("click", () => {
				if (recording) {
					// Stop
					recordPill.disabled = true;
					recordPill.removeClass("whisper-cal-pill-recording");
					void stopTomeRecording({app, notePath, transcriptFolderPath});
					return;
				}
				// Start
				recordPill.disabled = true;
				const handleRecord = async () => {
					try {
						if (!(app.vault.getAbstractFileByPath(notePath) instanceof TFile)) {
							await noteCreator.createNote(event);
						}
						await startTomeRecording({app, notePath, event, transcriptFolderPath});
						recording = true;
						recordPill.disabled = false;
						recordPill.addClass("whisper-cal-pill-recording");
						watchTomeRecording({app, notePath, transcriptFolderPath, onStopped: () => {
							recording = false;
							recordPill.disabled = true;
							recordPill.removeClass("whisper-cal-pill-recording");
						}});
					} catch (err) {
						new Notice(err instanceof Error ? err.message : "Failed to start Tome recording");
						recordPill.disabled = false;
					}
				};
				void handleRecord();
			});
		}
	}

	// Transcript pill (MacWhisper — hidden when Tome is enabled)
	if (!opts.tomeEnabled) {
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
	}

	// Speakers pill (LLM feature)
	if (opts.llmEnabled !== false) {
		const speakersPill = renderPill(actions, "users-round", "Speakers", states.speakers);
		if (states.speakers === "incomplete" && onTagSpeakers) {
			speakersPill.addEventListener("click", () => {
				const tf = resolveWikiLink(app, noteFm, "transcript", notePath);
				if (!tf) return;
				const transcriptFm = app.metadataCache.getFileCache(tf)?.frontmatter ?? {};
				onTagSpeakers(tf, transcriptFm as Record<string, unknown>, notePath);
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

	// Research pill (LLM feature, independent of pipeline workflow)
	if (opts.llmEnabled !== false) {
		const researchPill = renderPill(actions, "book-open", "Research", states.research);
		if (states.research === "incomplete" && onResearch) {
			researchPill.addEventListener("click", () => {
				onResearch(notePath);
			});
		} else if (states.research === "complete") {
			researchPill.addEventListener("click", () => {
				void app.workspace.openLinkText(notePath, "", false);
			});
		}
	}

	// Status lines below actions
	if (opts.llmEnabled !== false && states.research === "running") {
		const modelSuffix = opts.researchModel ? ` (${formatModelName(opts.researchModel)})` : "";
		const status = content.createDiv({cls: "whisper-cal-card-status"});
		const ico = status.createSpan({cls: "whisper-cal-card-status-icon"});
		setIcon(ico, "book-open");
		status.createSpan({text: `Researching${modelSuffix}\u2026`});
	}
	if (opts.llmEnabled !== false && states.speakers === "running") {
		const modelSuffix = opts.speakerTagModel ? ` (${formatModelName(opts.speakerTagModel)})` : "";
		const status = content.createDiv({cls: "whisper-cal-card-status"});
		const ico = status.createSpan({cls: "whisper-cal-card-status-icon"});
		setIcon(ico, "users-round");
		status.createSpan({text: `Tagging speakers${modelSuffix}\u2026`});
	}
	if (opts.llmEnabled !== false && states.summary === "running") {
		const modelSuffix = opts.summarizerModel ? ` (${formatModelName(opts.summarizerModel)})` : "";
		const status = content.createDiv({cls: "whisper-cal-card-status"});
		const ico = status.createSpan({cls: "whisper-cal-card-status-icon"});
		setIcon(ico, "sparkles");
		status.createSpan({text: `Summarizing${modelSuffix}\u2026`});
	}

	return card;
}
