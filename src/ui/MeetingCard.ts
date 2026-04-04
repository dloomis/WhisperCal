import {App, Notice, TFile, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {NameInputModal} from "./NameInputModal";
import {formatTime, formatRecordingDuration, formatElapsed} from "../utils/time";
import {resolveWikiLink} from "../utils/vault";
import {linkRecording} from "../services/LinkRecording";
import {updateFrontmatter} from "../utils/frontmatter";
import {summarizeJobs, speakerTagJobs, researchJobs, recordingState, cardStatus, expandedCards, recordingStartTime, type CardStatusVariant} from "../state";
import {ReRecordConfirmModal} from "./ReRecordConfirmModal";
import {removeFrontmatterKeys} from "../utils/frontmatter";
import type {PeopleMatchService} from "../services/PeopleMatchService";
import {startApiRecording, stopApiRecording, watchApiRecording} from "../services/ApiRecording";

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
	recordingApiBaseUrl?: string;
	onStatusUpdate?: () => void;
}

type PillState = "incomplete" | "complete" | "disabled" | "running";

interface PillStates {
	note: PillState;
	research: PillState;
	transcript: PillState;
	record: PillState;
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

/** Module-level duration timers keyed by notePath. Cleaned up on stop or card rebuild. */
const recDurationTimers = new Map<string, ReturnType<typeof setInterval>>();

function stopDurationTimer(notePath: string): void {
	const id = recDurationTimers.get(notePath);
	if (id != null) {
		clearInterval(id);
		recDurationTimers.delete(notePath);
	}
}

function startDurationTimer(notePath: string, textEl: HTMLElement): void {
	stopDurationTimer(notePath);
	const start = recordingStartTime.get(notePath) ?? Date.now();
	const tick = () => {
		if (!textEl.isConnected) { stopDurationTimer(notePath); return; }
		const elapsed = formatElapsed((Date.now() - start) / 1000);
		textEl.textContent = elapsed;
		cardStatus.set(notePath, {message: elapsed, variant: "recording"});
	};
	tick();
	recDurationTimers.set(notePath, setInterval(tick, 1000));
}

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

function renderGutter(card: HTMLElement, event: CalendarEvent, timezone: string, opts: MeetingCardOpts): {gutter: HTMLElement; timeDiv: HTMLElement | null; iconRow: HTMLElement} {
	const notAccepted = !event.isOrganizer && event.responseStatus !== "accepted" && event.responseStatus !== "organizer";
	const gutterCls = notAccepted
		? "whisper-cal-card-gutter whisper-cal-card-gutter-tentative"
		: "whisper-cal-card-gutter";
	const gutter = card.createDiv({cls: gutterCls});

	// Category color is shown via the grid icon only; the vertical bar mirrors gutter state

	let timeDivRef: HTMLElement | null = null;

	if (event.isAllDay) {
		gutter.createDiv({cls: "whisper-cal-card-gutter-time", text: "All Day"});
	} else if (event.id === "unscheduled") {
		gutter.createDiv({cls: "whisper-cal-card-gutter-time", text: "Ad Hoc"});
	} else {
		const timeStr = formatTime(event.startTime, timezone);
		const timeDiv = gutter.createDiv({cls: "whisper-cal-card-gutter-time"});
		timeDivRef = timeDiv;
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
	// Icon row — always created; holds optional status icons + collapse toggle
	const iconRow = gutter.createDiv({cls: "whisper-cal-card-gutter-icons"});

	if (event.isOrganizer) {
		const starEl = iconRow.createDiv({cls: "whisper-cal-card-gutter-organizer", attr: {"aria-label": "You are the organizer"}});
		setIcon(starEl, "star");
	}

	if (isImportantOrganizer) {
		const importantEl = iconRow.createDiv({cls: "whisper-cal-card-gutter-important", attr: {"aria-label": "Important organizer"}});
		setIcon(importantEl, "octagon-alert");
	}

	return {gutter, timeDiv: timeDivRef, iconRow};
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

	const record: PillState = recordingState.has(notePath)
		? "running"
		: noteFm["transcript"] ? "complete"
		: recordingState.size > 0 ? "disabled"
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

	return {note, research, transcript, record, speakers, summary, transcriptFile, transcriptPath, pipelineState};
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
	const {event, timezone, noteCreator, app, onNoteCreated} = opts;
	const card = container.createDiv({cls: "whisper-cal-card"});
	card.dataset.eventId = event.id;
	card.dataset.notePath = noteCreator.getNotePath(event);
	if (!event.isAllDay) {
		card.dataset.startTime = String(event.startTime.getTime());
		card.dataset.endTime = String(event.endTime.getTime());
	}

	const {iconRow} = renderGutter(card, event, timezone, opts);
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

	// Top-level unscheduled placeholder — just a Note pill, no state lookup
	if (event.id === "unscheduled") {
		const actions = content.createDiv({cls: "whisper-cal-card-actions"});
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

	// Collapse toggle — appended to the gutter icon row, pushed right
	// Restore expand/collapse state across refreshes via module-level set
	const isExpanded = expandedCards.has(opts.event.id);
	if (!isExpanded) card.addClass("whisper-cal-card-collapsed");
	const toggle = iconRow.createDiv({
		cls: "whisper-cal-card-toggle",
		attr: {"aria-label": isExpanded ? "Collapse actions" : "Expand actions"},
	});
	setIcon(toggle, "chevron-right");
	toggle.addEventListener("click", (e) => {
		e.stopPropagation();
		const nowCollapsed = card.classList.toggle("whisper-cal-card-collapsed");
		toggle.ariaLabel = nowCollapsed ? "Expand actions" : "Collapse actions";
		if (nowCollapsed) {
			expandedCards.delete(opts.event.id);
		} else {
			expandedCards.add(opts.event.id);
		}
	});

	// Dynamic zone — rebuilt in-place on card updates without touching static content
	const dynamicZone = content.createDiv({cls: "whisper-cal-card-dynamic"});
	renderCardDynamic(dynamicZone, card, opts);

	return card;
}

/** Build an onStatus callback that writes to the shared cardStatus map and triggers a card re-render. */
function onStatusForCard(
	notePath: string,
	opts: MeetingCardOpts,
): (msg: string | null, icon?: string, autoClearMs?: number, variant?: CardStatusVariant) => void {
	return (msg, icon, autoClearMs, variant) => {
		if (msg) {
			cardStatus.set(notePath, {message: msg, icon, variant});
		} else {
			cardStatus.delete(notePath);
		}
		opts.onStatusUpdate?.();
		if (msg && autoClearMs && autoClearMs > 0) {
			setTimeout(() => {
				if (cardStatus.get(notePath)?.message === msg) {
					cardStatus.delete(notePath);
					opts.onStatusUpdate?.();
				}
			}, autoClearMs);
		}
	};
}

/**
 * Populate the dynamic zone of a meeting card (pills, status lines, gutter highlight).
 * Called both on initial render and on in-place updates.
 */
function renderCardDynamic(
	zone: HTMLElement,
	cardEl: HTMLElement,
	opts: MeetingCardOpts,
): void {
	zone.empty();

	const {
		event, timezone, noteCreator, app,
		transcriptFolderPath = "Transcripts",
		recordingWindowMinutes = 10,
		onNoteCreated, onTagSpeakers, onSummarize, onResearch,
	} = opts;

	const states = computePillStates(app, noteCreator, event);
	const noteFile = noteCreator.findNote(event);
	const notePath = noteFile ? noteFile.path : noteCreator.getNotePath(event);
	const noteFm: Record<string, unknown> = noteFile
		? (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {})
		: {};

	// Update data-transcriptPath on the card element
	if (states.transcriptPath) {
		cardEl.dataset.transcriptPath = states.transcriptPath;
	} else {
		delete cardEl.dataset.transcriptPath;
	}

	// Update gutter highlight classes
	const gutter = cardEl.querySelector(".whisper-cal-card-gutter");
	if (gutter instanceof HTMLElement) {
		gutter.removeClass("whisper-cal-card-gutter-done");
		gutter.removeClass("whisper-cal-card-gutter-warning");
		if (states.summary === "complete") {
			gutter.addClass("whisper-cal-card-gutter-done");
		} else if (states.note === "complete") {
			gutter.addClass("whisper-cal-card-gutter-warning");
		}
	}

	// Actions row (wrapped for collapse animation)
	const actionsWrap = zone.createDiv({cls: "whisper-cal-card-actions-wrap"});
	const actions = actionsWrap.createDiv({cls: "whisper-cal-card-actions"});

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

	// Record pill (REST API recording — right after Note, before Research)
	const recordingApiBaseUrl = opts.recordingApiBaseUrl;
	if (recordingApiBaseUrl) {
		const recordPill = renderPill(actions, "mic", "Record", states.record);

		const addRecDot = () => {
			if (!recordPill.querySelector(".whisper-cal-pill-rec-dot")) {
				recordPill.createSpan({cls: "whisper-cal-pill-rec-dot"});
			}
			recordPill.addClass("whisper-cal-pill-recording");
		};
		const removeRecDot = () => {
			recordPill.querySelector(".whisper-cal-pill-rec-dot")?.remove();
			recordPill.removeClass("whisper-cal-pill-recording");
		};

		const setRecording = () => {
			if (!recordingStartTime.has(notePath)) recordingStartTime.set(notePath, Date.now());
			const start = recordingStartTime.get(notePath)!;
			const elapsed = formatElapsed((Date.now() - start) / 1000);
			cardStatus.set(notePath, {message: elapsed, variant: "recording"});
			opts.onStatusUpdate?.();
		};
		const clearRecording = () => {
			stopDurationTimer(notePath);
			recordingStartTime.delete(notePath);
			cardStatus.delete(notePath);
			opts.onStatusUpdate?.();
		};

		if (states.record === "running") {
			if (!recordingStartTime.has(notePath)) recordingStartTime.set(notePath, Date.now());
			const start = recordingStartTime.get(notePath)!;
			const elapsed = formatElapsed((Date.now() - start) / 1000);
			cardStatus.set(notePath, {message: elapsed, variant: "recording"});
			addRecDot();
		}
		if (states.record === "complete") {
			let reRecording = false;
			recordPill.addEventListener("click", () => {
				if (reRecording) {
					// Stop the re-recording
					recordPill.disabled = true;
					clearRecording();
					removeRecDot();
					void stopApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, onStatus: onStatusForCard(notePath, opts)});
					return;
				}
				void (async () => {
					const choice = await new ReRecordConfirmModal(app, {
						pipelineState: states.pipelineState,
					}).prompt();
					if (choice === "view") {
						const tf = resolveWikiLink(app, noteFm, "transcript", notePath);
						if (tf) void app.workspace.openLinkText(tf.path, "", false);
					} else if (choice === "re-record") {
						// Reset transcript-related frontmatter
						await removeFrontmatterKeys(app, notePath, [
							"transcript", "pipeline_state", "macwhisper_session_id",
						]);
						// Ensure note exists then start recording
						if (!(app.vault.getAbstractFileByPath(notePath) instanceof TFile)) {
							await noteCreator.createNote(event);
						}
						await startApiRecording({app, notePath, event, transcriptFolderPath, timezone, baseUrl: recordingApiBaseUrl});
						reRecording = true;
						setRecording();
						addRecDot();
						recordPill.disabled = false;
						watchApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, onStopped: () => {
							reRecording = false;
							recordPill.disabled = true;
							removeRecDot();
						}, onStatus: onStatusForCard(notePath, opts)});
					}
				})();
			});
		} else if (states.record === "running") {
			recordPill.disabled = false; // override — running pill is clickable to stop
			recordPill.addEventListener("click", () => {
				recordPill.disabled = true;
				clearRecording();
				removeRecDot();
				void stopApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, onStatus: onStatusForCard(notePath, opts)});
			});
		} else if (states.record === "incomplete") {
			let recording = false;
			recordPill.addEventListener("click", () => {
				if (recording) {
					// Stop
					recordPill.disabled = true;
					clearRecording();
					removeRecDot();
					void stopApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, onStatus: onStatusForCard(notePath, opts)});
					return;
				}
				// Start
				recordPill.disabled = true;
				const handleRecord = async () => {
					try {
						if (!(app.vault.getAbstractFileByPath(notePath) instanceof TFile)) {
							await noteCreator.createNote(event);
						}
						await startApiRecording({app, notePath, event, transcriptFolderPath, timezone, baseUrl: recordingApiBaseUrl});
						recording = true;
						recordPill.disabled = false;
						setRecording();
						addRecDot();
						watchApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, onStopped: () => {
							recording = false;
							recordPill.disabled = true;
							removeRecDot();
						}, onStatus: onStatusForCard(notePath, opts)});
					} catch (err) {
						new Notice(err instanceof Error ? err.message : "Failed to start recording");
						recordPill.disabled = false;
					}
				};
				void handleRecord();
			});
		}
	}

	// Transcript pill (MacWhisper — hidden when recording API is enabled)
	if (!recordingApiBaseUrl) {
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
							onStatus: onStatusForCard(notePath, opts),
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

	// Unified card status — renders from cardStatus map
	const cs = cardStatus.get(notePath);
	if (cs) {
		const variant = cs.variant ?? "progress";
		const statusEl = zone.createDiv({cls: `whisper-cal-card-status whisper-cal-card-status-${variant}`});
		if (cs.icon) {
			const ico = statusEl.createSpan({cls: "whisper-cal-card-status-icon"});
			setIcon(ico, cs.icon);
		}
		const textSpan = statusEl.createSpan({text: cs.message});
		// Live duration counter — updates the text span directly every second
		if (variant === "recording" && recordingStartTime.has(notePath)) {
			startDurationTimer(notePath, textSpan);
		}
	}
}

/** Update only the dynamic parts of an existing meeting card in-place. */
export function updateMeetingCard(cardEl: HTMLElement, opts: MeetingCardOpts): void {
	const dynamicZone = cardEl.querySelector(".whisper-cal-card-dynamic");
	if (!(dynamicZone instanceof HTMLElement)) return;
	renderCardDynamic(dynamicZone, cardEl, opts);
}
