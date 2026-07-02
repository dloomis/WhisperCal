import {App, Notice, TFile, normalizePath, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {NameInputModal} from "./NameInputModal";
import {formatTime, formatRecordingDuration, formatElapsed} from "../utils/time";
import {resolveWikiLink} from "../utils/vault";
import {linkRecording} from "../services/LinkRecording";
import {updateFrontmatter, batchUpdateFrontmatter} from "../utils/frontmatter";
import type {JobTracker} from "../services/JobTracker";
import {type CardStatusVariant, type CardUiState} from "../services/CardUiState";
import {FM} from "../constants";
import {ReRecordConfirmModal} from "./ReRecordConfirmModal";
import {ActiveRecordingNoticeModal} from "./ActiveRecordingNoticeModal";
import {recordingStatus} from "../services/RecordingApi";
import {removeFrontmatterKeys, isSingleSourceTranscript} from "../utils/frontmatter";
import type {PeopleMatchService} from "../services/PeopleMatchService";
import {startApiRecording, stopApiRecording, watchApiRecording} from "../services/ApiRecording";
import {LlmInstructionsModal} from "./LlmInstructionsModal";
import {hasCachedProposals} from "../services/SpeakerTagParser";

/**
 * Before starting a capture, consult the recording service's live /status. If it
 * reports an active recording, abort: there's only one audio source, so a
 * concurrent capture can't work (the service rejects /start). Show an informational
 * notice — naming the in-progress meeting when known — telling the user to stop
 * that recording first. Returns true to proceed, false to abort. A service that
 * isn't recording — or one that's unreachable — proceeds without a prompt;
 * startApiRecording surfaces any hard error from there. Note this only fires for an
 * active "recording" state: "transcribing" frees the mic, so a new recording may
 * start while a prior one finishes post-processing.
 */
async function confirmIfServiceRecording(app: App, baseUrl: string): Promise<boolean> {
	let status;
	try {
		status = await recordingStatus(baseUrl);
	} catch {
		// Unreachable, or an older service with no /status endpoint (e.g. a 404):
		// don't block recording on it — proceed and let startApiRecording report
		// any genuine failure.
		return true;
	}
	if (status.state !== "recording") return true;
	new ActiveRecordingNoticeModal(app, status.subject).open();
	return false;
}

function personnelTypeIcon(type: string): string | null {
	switch (type.toLowerCase()) {
		case "military": return "shield-half";
		case "civilian": return "landmark";
		case "contractor": return "briefcase";
		case "ffrdc": return "flask-conical";
		case "seta": return "microscope";
		case "foreign national": return "globe";
		case "c-suite": return "crown";
		default: return null;
	}
}

export interface MeetingCardOpts {
	event: CalendarEvent;
	timezone: string;
	noteCreator: NoteCreator;
	app: App;
	jobs: JobTracker;
	cardUi: CardUiState;
	transcriptFolderPath?: string;
	recordingWindowMinutes?: number;
	onNoteCreated?: (eventId: string) => void;
	importantOrganizerEmails?: readonly string[];
	llmEnabled?: boolean;
	onTagSpeakers?: (transcriptFile: TFile, transcriptFm: Record<string, unknown>, notePath: string, customInstructions?: string) => void;
	onReviewSpeakerCandidates?: (notePath: string) => void;
	onSummarize?: (notePath: string, force?: boolean, customInstructions?: string) => void;
	onResearch?: (notePath: string) => void;
	peopleMatchService?: PeopleMatchService;
	recordingApiBaseUrl?: string;
	onStatusUpdate?: () => void;
	isMergeSelected?: () => boolean;
	onToggleMergeSelect?: (selected: boolean) => void;
}

/**
 * Apply expand/collapse state to a meeting card: updates the DOM class and
 * toggle aria-label, and persists the choice in cardUi. Shared by the carat
 * click handler and the auto-collapse-on-summary trigger.
 */
export function setCardCollapsed(card: HTMLElement, eventId: string, cardUi: CardUiState, collapsed: boolean): void {
	card.toggleClass("whisper-cal-card-collapsed", collapsed);
	const toggle = card.querySelector<HTMLElement>(".whisper-cal-card-toggle");
	if (toggle) toggle.ariaLabel = collapsed ? "Expand actions" : "Collapse actions";
	if (collapsed) cardUi.collapse(eventId);
	else cardUi.expand(eventId);
}

type PillState = "incomplete" | "complete" | "disabled" | "running";

interface PillStates {
	note: PillState;
	research: PillState;
	transcript: PillState;
	record: PillState;
	speakers: PillState;
	summary: PillState;
	/** Cached LLM speaker proposals are waiting for review (accent dot on the pill). */
	speakersCandidatesReady: boolean;
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

function startDurationTimer(cardUi: CardUiState, notePath: string, textEl: HTMLElement): void {
	cardUi.stopDurationTimer(notePath);
	const tick = () => {
		if (!textEl.isConnected) { cardUi.stopDurationTimer(notePath); return; }
		// Read the anchor each tick (not captured once) so a re-sync to the
		// recording service's reported start time takes effect mid-recording.
		const start = cardUi.getStartTime(notePath);
		if (start === undefined) return;
		const elapsed = formatElapsed((Date.now() - start) / 1000);
		textEl.textContent = elapsed;
		cardUi.setStatus(notePath, {message: elapsed, variant: "recording"});
	};
	tick();
	cardUi.startDurationTimer(notePath, tick, 1000);
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

	// Top row — time + merge checkbox, level with the meeting title line
	const topRow = gutter.createDiv({cls: "whisper-cal-card-gutter-toprow"});

	if (event.isAllDay) {
		topRow.createDiv({cls: "whisper-cal-card-gutter-time", text: "All Day"});
	} else if (event.id === "unscheduled") {
		topRow.createDiv({cls: "whisper-cal-card-gutter-time", text: "Ad Hoc"});
	} else {
		const timeStr = formatTime(event.startTime, timezone);
		const timeDiv = topRow.createDiv({cls: "whisper-cal-card-gutter-time"});
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

	// Merge checkbox — static zone so it survives dynamic-zone rebuilds.
	// Eligibility (note must exist) is toggled by renderCardDynamic.
	// A merged card is already a source-of-truth aggregate; don't offer to merge it again.
	if (event.id !== "unscheduled" && !event.isMerged && opts.onToggleMergeSelect) {
		const mergeCb = topRow.createEl("input", {
			type: "checkbox",
			cls: "whisper-cal-merge-checkbox whisper-cal-merge-checkbox-hidden",
			attr: {"aria-label": "Select meeting to merge"},
		});
		mergeCb.checked = opts.isMergeSelected?.() ?? false;
		mergeCb.addEventListener("click", (e) => e.stopPropagation());
		mergeCb.addEventListener("change", () => opts.onToggleMergeSelect?.(mergeCb.checked));
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

	if (event.isMerged) {
		const mergedEl = iconRow.createDiv({cls: "whisper-cal-card-gutter-merged", attr: {"aria-label": "Merged meeting"}});
		setIcon(mergedEl, "git-merge");
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

		const accepted = event.attendees.filter(a => a.responseStatus === "accepted" || a.responseStatus === "organizer").length;
		const tentative = event.attendees.filter(a => a.responseStatus === "tentativelyAccepted").length;
		const declined = event.attendees.filter(a => a.responseStatus === "declined").length;

		if (accepted > 0) {
			const el = meta.createSpan({cls: "whisper-cal-card-meta-item whisper-cal-rsvp-accepted"});
			const icon = el.createSpan({cls: "whisper-cal-card-icon"});
			setIcon(icon, "user-round-check");
			el.createSpan({text: `${accepted}`});
		}
		if (tentative > 0) {
			const names = event.attendees.filter(a => a.responseStatus === "tentativelyAccepted").map(a => a.name || a.email);
			const el = meta.createSpan({cls: "whisper-cal-card-meta-item whisper-cal-rsvp-tentative", attr: {"aria-label": `Tentative: ${names.join(", ")}`}});
			const icon = el.createSpan({cls: "whisper-cal-card-icon"});
			setIcon(icon, "user-round-minus");
			el.createSpan({text: `${tentative}`});
		}
		if (declined > 0) {
			const names = event.attendees.filter(a => a.responseStatus === "declined").map(a => a.name || a.email);
			const el = meta.createSpan({cls: "whisper-cal-card-meta-item whisper-cal-rsvp-declined", attr: {"aria-label": `Declined: ${names.join(", ")}`}});
			const icon = el.createSpan({cls: "whisper-cal-card-icon"});
			setIcon(icon, "user-round-x");
			el.createSpan({text: `${declined}`});
		}
	}
}

function computePillStates(
	app: App,
	noteCreator: NoteCreator,
	event: CalendarEvent,
	jobs: JobTracker,
	cardUi: CardUiState,
): PillStates {
	const noteFile = noteCreator.findNote(event);
	const notePath = noteFile ? noteFile.path : noteCreator.getNotePath(event);
	const noteExists = noteFile !== null;
	const noteFm: Record<string, unknown> = noteFile
		? (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {})
		: {};

	const note: PillState = noteExists ? "complete" : "incomplete";
	// Research stays enabled even without a parent note — clicking it
	// auto-creates the note first (via NoteCreator.ensureNote).
	// Done is the plugin-written marker (set on a successful run), matching the
	// other pills. research_notes is a legacy fallback — it was written on note
	// selection before the run, so it predates the marker on already-researched
	// notes; new runs always set research_state.
	const research: PillState = jobs.has("research", notePath) ? "running"
		: (noteFm[FM.RESEARCH_STATE] === "research-done" || noteFm["research_notes"]) ? "complete"
		: "incomplete";
	const transcript: PillState = !noteExists
		? "disabled"
		: noteFm[FM.TRANSCRIPT] ? "complete" : "incomplete";

	// No cross-card "one at a time" lock: a sibling card recording (or, worse, a
	// stale entry from one that already moved to transcribing) must not grey out
	// this pill. The record click consults the recording service's live /status
	// instead and lets the user decide — see confirmIfServiceRecording.
	const record: PillState = cardUi.hasRecording(notePath)
		? "running"
		: noteFm[FM.TRANSCRIPT] ? "complete"
		: "incomplete";

	const pipelineState = noteFm[FM.PIPELINE_STATE] as string | undefined;
	const transcriptFile = noteFm[FM.TRANSCRIPT]
		? resolveWikiLink(app, noteFm, FM.TRANSCRIPT, notePath)
		: null;
	const transcriptPath = transcriptFile?.path ?? "";

	const speakers: PillState = transcript !== "complete"
		? "disabled"
		: (pipelineState && pipelineState !== "titled") ? "complete"
		: jobs.has("speakerTag", transcriptPath) ? "running"
		: "incomplete";

	const speakersCandidatesReady = speakers === "incomplete"
		&& transcriptPath !== ""
		&& hasCachedProposals(app, transcriptPath);

	const summary: PillState = speakers !== "complete"
		? "disabled"
		: pipelineState === "summarized" ? "complete"
		: jobs.has("summarize", notePath) ? "running"
		: "incomplete";

	return {note, research, transcript, record, speakers, summary, speakersCandidatesReady, transcriptFile, transcriptPath, pipelineState};
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
	if (noteFm[FM.MACWHISPER_SESSION_ID]) return; // already present

	const transcriptFile = resolveWikiLink(app, noteFm, FM.TRANSCRIPT, noteFile.path);
	if (!transcriptFile) return;

	const transcriptFm = app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {};
	const sessionId = transcriptFm[FM.MACWHISPER_SESSION_ID] as string | undefined;
	if (!sessionId) return;

	await updateFrontmatter(app, noteFile.path, FM.MACWHISPER_SESSION_ID, sessionId);
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
		const personInfo = opts.peopleMatchService
			? opts.peopleMatchService.matchOneInfo(event.organizerName, event.organizerEmail)
			: null;

		const orgEl = orgRow.createSpan({cls: "whisper-cal-card-meta-item"});
		const orgIcon = orgEl.createSpan({cls: "whisper-cal-card-icon"});
		const typeIcon = personInfo ? personnelTypeIcon(personInfo.personnelType) : null;
		setIcon(orgIcon, typeIcon ?? "user");

		if (personInfo) {
			const displayName = personInfo.notePath.split("/").pop() ?? event.organizerName;
			const link = orgEl.createEl("a", {
				cls: "whisper-cal-card-meta-link",
				text: displayName,
			});
			link.addEventListener("click", (e) => {
				e.preventDefault();
				void app.workspace.openLinkText(personInfo.notePath, "", false);
			});
		} else {
			orgEl.createSpan({text: event.organizerName});
		}
	}

	// Collapse toggle — appended to the gutter icon row, pushed right
	// Restore expand/collapse state across refreshes via module-level set
	const isExpanded = opts.cardUi.isExpanded(opts.event.id);
	if (!isExpanded) card.addClass("whisper-cal-card-collapsed");
	const toggle = iconRow.createDiv({
		cls: "whisper-cal-card-toggle",
		attr: {"aria-label": isExpanded ? "Collapse actions" : "Expand actions"},
	});
	setIcon(toggle, "chevron-right");
	toggle.addEventListener("click", (e) => {
		e.stopPropagation();
		const willCollapse = !card.hasClass("whisper-cal-card-collapsed");
		setCardCollapsed(card, opts.event.id, opts.cardUi, willCollapse);
	});

	// Top-level unscheduled placeholder — just a Note pill, no state lookup
	if (event.id === "unscheduled") {
		const actionsWrap = content.createDiv({cls: "whisper-cal-card-actions-wrap"});
		const actions = actionsWrap.createDiv({cls: "whisper-cal-card-actions"});
		const notePill = renderPill(actions, "file-plus-2", "Meeting note", "incomplete");
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

	// Dynamic zone — rebuilt in-place on card updates without touching static content
	const dynamicZone = content.createDiv({cls: "whisper-cal-card-dynamic"});
	renderCardDynamic(dynamicZone, card, opts);

	return card;
}

/** Build an onStatus callback that writes to the shared CardUiState and triggers a card re-render. */
function onStatusForCard(
	notePath: string,
	opts: MeetingCardOpts,
): (msg: string | null, icon?: string, autoClearMs?: number, variant?: CardStatusVariant) => void {
	const {cardUi} = opts;
	return (msg, icon, autoClearMs, variant) => {
		if (msg) {
			cardUi.setStatus(notePath, {message: msg, icon, variant});
		} else {
			cardUi.deleteStatus(notePath);
		}
		opts.onStatusUpdate?.();
		if (msg && autoClearMs && autoClearMs > 0) {
			setTimeout(() => {
				if (cardUi.getStatus(notePath)?.message === msg) {
					cardUi.deleteStatus(notePath);
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

	const states = computePillStates(app, noteCreator, event, opts.jobs, opts.cardUi);
	const noteFile = noteCreator.findNote(event);
	const notePath = noteFile ? noteFile.path : noteCreator.getNotePath(event);
	const noteFm: Record<string, unknown> = noteFile
		? (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {})
		: {};

	// Keep dataset paths in sync with actual note/transcript paths so that
	// rerenderCardByPath lookups succeed even when the calendar event subject
	// diverges from the note filename (e.g. organizer renamed the meeting).
	cardEl.dataset.notePath = notePath;
	if (states.transcriptPath) {
		cardEl.dataset.transcriptPath = states.transcriptPath;
	} else {
		delete cardEl.dataset.transcriptPath;
	}

	// Merge checkbox eligibility — only cards with an existing note can merge
	const mergeCb = cardEl.querySelector<HTMLInputElement>(".whisper-cal-merge-checkbox");
	if (mergeCb) {
		const eligible = states.note === "complete";
		mergeCb.toggleClass("whisper-cal-merge-checkbox-hidden", !eligible);
		if (!eligible && mergeCb.checked) {
			mergeCb.checked = false;
			opts.onToggleMergeSelect?.(false);
		}
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

	// Record pill (REST API recording — first in the row)
	const recordingApiBaseUrl = opts.recordingApiBaseUrl;
	if (recordingApiBaseUrl) {
		const recordPill = renderPill(actions, "mic", "Record", states.record);
		recordPill.addClass("whisper-cal-pill-mic");

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

		const {cardUi} = opts;
		const setRecording = () => {
			if (cardUi.getStartTime(notePath) === undefined) cardUi.setStartTime(notePath, Date.now());
			const start = cardUi.getStartTime(notePath)!;
			const elapsed = formatElapsed((Date.now() - start) / 1000);
			cardUi.setStatus(notePath, {message: elapsed, variant: "recording"});
			opts.onStatusUpdate?.();
		};
		const clearRecording = () => {
			cardUi.stopDurationTimer(notePath);
			cardUi.deleteStartTime(notePath);
			cardUi.deleteStatus(notePath);
			opts.onStatusUpdate?.();
		};

		if (states.record === "running") {
			if (cardUi.getStartTime(notePath) === undefined) cardUi.setStartTime(notePath, Date.now());
			const start = cardUi.getStartTime(notePath)!;
			const elapsed = formatElapsed((Date.now() - start) / 1000);
			cardUi.setStatus(notePath, {message: elapsed, variant: "recording"});
			addRecDot();
		}
		if (states.record === "complete") {
			let reRecording = false;
			recordPill.addEventListener("click", () => {
				if (reRecording) {
					// Stop the re-recording. stopApiRecording deletes the recording
					// entry first (synchronously, before its first await), which fires
					// the recordings-change subscriber → re-render. clearRecording runs
					// after so the final render sees fully torn-down state and can't
					// resurrect the recording status/timer.
					recordPill.disabled = true;
					void stopApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, cardUi: opts.cardUi, onStatus: onStatusForCard(notePath, opts)});
					clearRecording();
					removeRecDot();
					return;
				}
				void (async () => {
					const choice = await new ReRecordConfirmModal(app, {
						pipelineState: states.pipelineState,
					}).prompt();
					if (choice === "view") {
						const tf = resolveWikiLink(app, noteFm, FM.TRANSCRIPT, notePath);
						if (tf) void app.workspace.openLinkText(tf.path, "", false);
					} else if (choice === "re-record") {
						recordPill.disabled = true;
						try {
							// Defer to the recording service on whether the mic is free;
							// confirm with the user if it's mid-recording. Abort cleanly on cancel.
							if (!(await confirmIfServiceRecording(app, recordingApiBaseUrl))) {
								recordPill.disabled = false;
								return;
							}
							// Ensure note exists, then start recording. startApiRecording
							// runs its readiness checks before any state mutates, so reset the
							// transcript frontmatter only once the capture is underway — a
							// failed start leaves the note's existing transcript link intact.
							await noteCreator.ensureNote(event);
							await startApiRecording({app, notePath, event, transcriptFolderPath, timezone, baseUrl: recordingApiBaseUrl, cardUi: opts.cardUi});
							await removeFrontmatterKeys(app, notePath, [
								FM.TRANSCRIPT, FM.PIPELINE_STATE, FM.MACWHISPER_SESSION_ID,
							]);
							reRecording = true;
							setRecording();
							addRecDot();
							recordPill.disabled = false;
							watchApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, cardUi: opts.cardUi, onStopped: () => {
								reRecording = false;
								recordPill.disabled = true;
								removeRecDot();
							}, onStatus: onStatusForCard(notePath, opts)});
						} catch (err) {
							new Notice(err instanceof Error ? err.message : "Failed to start recording");
							recordPill.disabled = false;
						}
					}
				})();
			});
		} else if (states.record === "running") {
			recordPill.disabled = false; // override — running pill is clickable to stop
			recordPill.addEventListener("click", () => {
				recordPill.disabled = true;
				void stopApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, cardUi: opts.cardUi, onStatus: onStatusForCard(notePath, opts)});
				clearRecording();
				removeRecDot();
			});
		} else if (states.record === "incomplete") {
			let recording = false;
			recordPill.addEventListener("click", () => {
				if (recording) {
					// Stop. stopApiRecording deletes the recording entry first
					// (synchronously, before its first await) so the final re-render
					// from clearRecording sees torn-down state — see the re-record
					// stop path above.
					recordPill.disabled = true;
					void stopApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, cardUi: opts.cardUi, onStatus: onStatusForCard(notePath, opts)});
					clearRecording();
					removeRecDot();
					return;
				}
				// Start
				recordPill.disabled = true;
				const handleRecord = async () => {
					try {
						// Detect an orphaned transcript file on disk that the note's
						// frontmatter doesn't link to (e.g. a prior recording where the
						// link write silently dropped). Without this, re-recording would
						// overwrite the file with no warning.
						const noteBasename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
						const expectedTranscriptPath = normalizePath(
							`${transcriptFolderPath}/${noteBasename} - Transcript.md`,
						);
						const orphanedTranscript = noteBasename
							? app.vault.getAbstractFileByPath(expectedTranscriptPath)
							: null;
						if (orphanedTranscript instanceof TFile) {
							const choice = await new ReRecordConfirmModal(app, {
								pipelineState: states.pipelineState,
								linked: false,
							}).prompt();
							if (choice === "view") {
								recordPill.disabled = false;
								// Heal the broken linkage so the note's pipeline state
								// reflects reality before we navigate away. Mirrors what
								// waitAndLink would have written had it not silently failed.
								try {
									await batchUpdateFrontmatter(app, notePath, {
										[FM.TRANSCRIPT]: `[[${orphanedTranscript.basename}]]`,
										[FM.PIPELINE_STATE]: "titled",
									});
									new Notice("Restored transcript link in meeting note");
								} catch (err) {
									console.error("[WhisperCal] Failed to heal transcript link:", err);
									new Notice("Couldn't restore transcript link — see console");
								}
								void app.workspace.openLinkText(orphanedTranscript.path, "", false);
								return;
							}
							if (choice !== "re-record") {
								recordPill.disabled = false;
								return;
							}
							// Defensive: clear any stale pipeline frontmatter that may
							// have been partially written before the link step failed.
							await removeFrontmatterKeys(app, notePath, [
								FM.TRANSCRIPT, FM.PIPELINE_STATE, FM.MACWHISPER_SESSION_ID,
							]);
						}
						// Defer to the recording service on whether the mic is free;
						// confirm with the user if it's mid-recording. Abort cleanly on cancel.
						if (!(await confirmIfServiceRecording(app, recordingApiBaseUrl))) {
							recordPill.disabled = false;
							return;
						}
						await noteCreator.ensureNote(event);
						await startApiRecording({app, notePath, event, transcriptFolderPath, timezone, baseUrl: recordingApiBaseUrl, cardUi: opts.cardUi});
						recording = true;
						recordPill.disabled = false;
						setRecording();
						addRecDot();
						watchApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, cardUi: opts.cardUi, onStopped: () => {
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

	// Link-recording pill (MacWhisper — hidden when recording API is enabled).
	// Occupies the record slot: it attaches a recording to the note.
	if (!recordingApiBaseUrl) {
		const linkPill = renderPill(actions, "mic", "Link recording", states.transcript);
		linkPill.addClass("whisper-cal-pill-mic");
		if (states.transcript !== "disabled") {
			linkPill.addEventListener("click", () => {
				if (states.transcript === "complete") {
					const tf = resolveWikiLink(app, noteFm, FM.TRANSCRIPT, notePath);
					if (tf) void app.workspace.openLinkText(tf.path, "", false);
					return;
				}
				linkPill.disabled = true;
				const handleMic = async () => {
					let linked = false;
					try {
						await noteCreator.ensureNote(event);
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
						if (!linked) linkPill.disabled = false;
					}
				};
				void handleMic();
			});
		}
	}

	// Spacer + delimiter separating the recording pill from the rest of the
	// row, so the mic is harder to hit by accident.
	actions.createDiv({cls: "whisper-cal-pill-divider"});

	// Meeting note pill — notebook-pen (vs generic file-text) keeps it visually
	// distinct from the Transcript pill.
	// The accent "complete" border means the meeting is fully summarized —
	// an existing-but-unsummarized note is still in progress, so it keeps
	// the neutral border.
	const noteIcon = states.note === "complete" ? "notebook-pen" : "file-plus-2";
	const notePillState: PillState =
		states.note === "complete" && states.summary === "complete" ? "complete" : "incomplete";
	const noteWrap = actions.createDiv({cls: "whisper-cal-pill-wrap"});
	const notePill = renderPill(noteWrap, noteIcon, "Meeting note", notePillState);
	// Pulsing accent border while summarization runs (pill stays clickable)
	if (states.summary === "running") notePill.addClass("whisper-cal-pill-busy");
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

	// Summary corner badge — replaces the old Summary pill (a completed
	// summary's pill was just a second "open note" button). Ready state is a
	// visible call-to-action; complete state is hover-revealed for the rare
	// regenerate. Clicks go through the instructions modal (empty Run = plain
	// run) so per-run custom instructions keep their entry point.
	if (opts.llmEnabled !== false && onSummarize && states.summary !== "disabled") {
		const badge = noteWrap.createEl("button", {cls: "whisper-cal-pill-corner-badge"});
		// All corner badges use a "+" — the tooltip carries the meaning.
		setIcon(badge, "plus");
		if (states.summary === "running") {
			badge.addClass("is-running");
			badge.setAttribute("aria-label", "Summarizing…");
			badge.disabled = true;
		} else {
			const regen = states.summary === "complete";
			if (!regen) badge.addClass("is-ready");
			badge.setAttribute("aria-label", regen ? "Re-run summarization with optional instructions" : "Summarize meeting");
			badge.addEventListener("click", (e) => {
				e.stopPropagation();
				void (async () => {
					const instructions = await new LlmInstructionsModal(app, {
						title: regen ? "Regenerate summary with instructions" : "Summarize with instructions",
						subtitle: event.subject,
					}).prompt();
					if (instructions === null) return; // cancelled
					onSummarize(notePath, regen, instructions || undefined);
				})();
			});
		}
	}

	// Transcript pill — opens the transcript file; disabled until one exists.
	// Speaker tagging lives in the corner badge (mirroring the Meeting note pill's
	// summary badge), so the transcript stays reachable while tagging runs.
	{
		const transcriptWrap = actions.createDiv({cls: "whisper-cal-pill-wrap"});
		const transcriptPillState: PillState = states.speakers === "disabled" ? "disabled"
			: states.speakers === "complete" ? "complete"
			: "incomplete";
		const transcriptPill = renderPill(transcriptWrap, "users-round", "Transcript", transcriptPillState);
		// Pulsing accent border while tagging runs (pill stays clickable)
		if (states.speakers === "running") transcriptPill.addClass("whisper-cal-pill-busy");
		if (transcriptPillState !== "disabled") {
			transcriptPill.addEventListener("click", () => {
				const tf = resolveWikiLink(app, noteFm, FM.TRANSCRIPT, notePath);
				if (tf) void app.workspace.openLinkText(tf.path, "", false);
			});
		}

		// Speakers corner badge: visible call-to-action while tagging is
		// pending (dot overlay when cached candidates await review), pulsing
		// while running, hover-revealed "+" re-run once tags are applied.
		if (opts.llmEnabled !== false && states.speakers !== "disabled") {
			const badge = transcriptWrap.createEl("button", {cls: "whisper-cal-pill-corner-badge"});
			// All corner badges use a "+" — the tooltip carries the meaning.
			setIcon(badge, "plus");
			if (states.speakers === "running") {
				badge.addClass("is-running");
				badge.setAttribute("aria-label", "Post-processing transcript…");
				badge.disabled = true;
			} else if (states.speakers === "complete") {
				// Review/edit the applied speaker tags (hover-revealed). No LLM re-run —
				// opens the modal pre-filled with the current assignments so you can correct
				// a name; Apply re-labels the body and re-writes the tags.
				badge.setAttribute("aria-label", "Review and edit speaker tags");
				badge.addEventListener("click", (e) => {
					e.stopPropagation();
					opts.onReviewSpeakerCandidates?.(notePath);
				});
			} else if (states.speakersCandidatesReady) {
				// Unapproved candidates cached: green badge, click resumes the
				// review directly. Re-run becomes available after approval.
				badge.addClass("is-ready");
				badge.addClass("has-candidates");
				badge.setAttribute("aria-label", "Review speaker candidates");
				badge.addEventListener("click", (e) => {
					e.stopPropagation();
					opts.onReviewSpeakerCandidates?.(notePath);
				});
			} else if (onTagSpeakers) {
				badge.addClass("is-ready");
				badge.setAttribute("aria-label", "Tag speakers");
				badge.addEventListener("click", (e) => {
					e.stopPropagation();
					const tf = resolveWikiLink(app, noteFm, FM.TRANSCRIPT, notePath);
					if (!tf) return;
					const transcriptFm = (app.metadataCache.getFileCache(tf)?.frontmatter ?? {}) as Record<string, unknown>;
					// Single-source recordings (voice memos, single-speaker
					// diarization) often capture more people than the mic
					// suggests — the instructions modal carries the hint prompt.
					// Empty Run proceeds normally; cancel aborts.
					const singleSource = isSingleSourceTranscript(transcriptFm);
					void (async () => {
						const instructions = await new LlmInstructionsModal(app, {
							title: "Tag speakers with instructions",
							subtitle: singleSource
								? "Single-mic recording — if more than one person spoke, say how many and who's who."
								: event.subject,
							...(singleSource
								? {placeholder: "e.g. \"Phone call held up to the mic: I am the local speaker, the other voice is Joe Jackson.\""}
								: {}),
						}).prompt();
						if (instructions === null) return; // cancelled
						onTagSpeakers(tf, transcriptFm, notePath, instructions || undefined);
					})();
				});
			}
		}
	}

	// Research pill (LLM feature, independent of pipeline workflow)
	if (opts.llmEnabled !== false) {
		const researchPill = renderPill(actions, "book-open", "Research", states.research);
		// Research is re-runnable: clicking re-opens the research flow whether or not a
		// prior run finished. Series prep in particular expects multiple reruns, so the
		// "complete" state must stay a live re-run button (the checkmark is just a
		// "done once" marker) — not a dead-end that only opens the note. Opening the
		// note is already covered by the note pill. A "running" pill is disabled by
		// renderPill, so it's excluded here.
		if (onResearch && (states.research === "incomplete" || states.research === "complete")) {
			researchPill.addEventListener("click", () => {
				researchPill.disabled = true;
				void (async () => {
					try {
						// Auto-create the parent note if it's missing, then research.
						const hadNote = noteFile !== null;
						const path = await noteCreator.ensureNote(event);
						if (!hadNote && onNoteCreated) onNoteCreated(event.id);
						onResearch(path);
					} finally {
						researchPill.disabled = false;
					}
				})();
			});
		}
	}

	// Unified card status — renders from CardUiState
	const cs = opts.cardUi.getStatus(notePath);
	if (cs) {
		const variant = cs.variant ?? "progress";
		const statusEl = zone.createDiv({cls: `whisper-cal-card-status whisper-cal-card-status-${variant}`});
		if (cs.icon) {
			const ico = statusEl.createSpan({cls: "whisper-cal-card-status-icon"});
			setIcon(ico, cs.icon);
		}
		const textSpan = statusEl.createSpan({text: cs.message});
		// Live duration counter — updates the text span directly every second
		if (variant === "recording" && opts.cardUi.getStartTime(notePath) !== undefined) {
			startDurationTimer(opts.cardUi, notePath, textSpan);
		}
	}
}

/** Update only the dynamic parts of an existing meeting card in-place. */
export function updateMeetingCard(cardEl: HTMLElement, opts: MeetingCardOpts): void {
	const dynamicZone = cardEl.querySelector(".whisper-cal-card-dynamic");
	if (!(dynamicZone instanceof HTMLElement)) return;
	renderCardDynamic(dynamicZone, cardEl, opts);
}
