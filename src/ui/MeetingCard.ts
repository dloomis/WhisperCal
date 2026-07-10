import {App, Menu, Notice, TFile, normalizePath, setIcon, setTooltip} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {NameInputModal} from "./NameInputModal";
import {formatTime, formatRecordingDuration, formatElapsed} from "../utils/time";
import {openMeetingUrl, meetingAppForUrl} from "../utils/meetingLink";
import {closeMeetingApp} from "../services/MeetingAppCloser";
import {resolveWikiLink} from "../utils/vault";
import {addActivateOnKey} from "../utils/a11y";
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
import {hasCachedProposals, countCachedProposals} from "../services/SpeakerTagParser";
import {exportMeetingBundle} from "../services/MeetingExporter";
import {collectMeetingRelatedFiles, trashMeetingFiles} from "../services/MeetingDeleter";
import {renameMeetingFiles} from "../services/MeetingRenamer";
import {DeleteNoteModal} from "./DeleteNoteModal";
import {RenameNoteModal} from "./RenameNoteModal";

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
	onNoteDeleted?: () => void;
	onNoteRenamed?: () => void;
	peopleMatchService?: PeopleMatchService;
	recordingApiBaseUrl?: string;
	/**
	 * Automate the meeting's recording lifecycle: auto-start capture when the
	 * join link is clicked, and close the meeting app when the recording is
	 * stopped from WhisperCal (driven by the automateMeetingRecording setting).
	 */
	automateMeeting?: boolean;
	onStatusUpdate?: () => void;
	isMergeSelected?: () => boolean;
	onToggleMergeSelect?: (selected: boolean) => void;
}

type PillState = "incomplete" | "complete" | "disabled" | "running";

interface PillStates {
	note: PillState;
	research: PillState;
	transcript: PillState;
	record: PillState;
	speakers: PillState;
	summary: PillState;
	/** Cached speaker proposals await review — morphs the transcript pill into "Review speakers". */
	speakersCandidatesReady: boolean;
	transcriptFile: TFile | null;
	transcriptPath: string;
	pipelineState: string | undefined;
}

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

type RailSegState = "done" | "running" | "attention" | "rec" | "pending";

/**
 * Completion-celebration bookkeeping, keyed by note path: each card's per-stage
 * done flags from its previous render (so a false→true flip — the stage just
 * finished — can be detected) plus the windows during which a rebuilt rail
 * should (re)play the one-shot animations (see .whisper-cal-rail-complete and
 * .whisper-cal-rail-seg-complete in styles.css). Windows rather than one-shot
 * flags because the success paths re-render the card several times
 * back-to-back (frontmatter change, then a status badge) and every render
 * rebuilds the rail from scratch — re-applying the class inside the window
 * beats letting a rebuild cut the animation short. Module-level so the state
 * survives those rebuilds; reset on plugin reload, which is fine — the first
 * render of a card only seeds the map, so already-finished stages never
 * celebrate on view open or day change.
 */
interface CelebrationState {
	/** Per-stage done flags from the previous render (Note, Transcript, Speakers, Summary). */
	prevDone: [boolean, boolean, boolean, boolean];
	/** Full-rail wave window — set when Summary flips (the end-to-end finish). */
	railUntil: number;
	/** Per-segment fill windows — set when an individual stage flips. */
	segUntil: [number, number, number, number];
	/** Stagger delays for stages that flipped in the same render. */
	segDelay: [number, number, number, number];
}
const celebrations = new Map<string, CelebrationState>();
const CELEBRATION_WINDOW_MS = 2500;
const CELEBRATION_STAGGER_MS = 90;

/**
 * Render one segment of the 4-bar status rail. Hovering the rail expands
 * every segment into a labeled bar (the stage name), so the enabled segments
 * need no tooltip. Clickable when an onClick is supplied — opening the stage's
 * artifact — otherwise quiet: the stage is pending and its artifact doesn't
 * exist yet, and a disabledTooltip (e.g. "No transcript detected") explains why
 * on hover.
 *
 * Disabled segments use `aria-disabled` rather than the native `disabled`
 * property: a real disabled button swallows pointer events, so the tooltip
 * would never fire on hover. With no click listener attached, aria-disabled is
 * inert to activation while still receiving hover and announcing its state.
 */
function renderRailSeg(
	rail: HTMLElement,
	label: string,
	state: RailSegState,
	onClick?: () => void,
	disabledTooltip?: string,
	pulse?: boolean,
): void {
	const seg = rail.createEl("button", {cls: "whisper-cal-rail-seg"});
	seg.createSpan({cls: "whisper-cal-rail-seg-label", text: label});
	if (state !== "pending") seg.addClass(`whisper-cal-rail-seg-${state}`);
	// Pulse without recoloring: an active job on a segment that keeps its own
	// state color (e.g. research running on an already-created green Note stage).
	if (pulse) seg.addClass("whisper-cal-rail-seg-pulsing");
	if (onClick) {
		seg.addEventListener("click", onClick);
	} else {
		seg.setAttr("aria-disabled", "true");
		if (disabledTooltip) setTooltip(seg, disabledTooltip);
	}
}

/**
 * Build a smart action button: an icon + a full text label (+ an optional count
 * chip). The pipeline's single "next verb" button that replaces the old pill row.
 */
function renderSmartBtn(
	container: HTMLElement,
	icon: string,
	label: string,
	opts: {cls?: string; count?: number; disabled?: boolean; ariaLabel: string},
): HTMLButtonElement {
	const btn = container.createEl("button", {
		cls: "whisper-cal-smart" + (opts.cls ? " " + opts.cls : ""),
		attr: {"aria-label": opts.ariaLabel},
	});
	const ico = btn.createSpan({cls: "whisper-cal-smart-icon"});
	setIcon(ico, icon);
	btn.createSpan({cls: "whisper-cal-smart-label", text: label});
	if (opts.count !== undefined && opts.count > 0) {
		btn.createSpan({cls: "whisper-cal-smart-count", text: String(opts.count)});
	}
	if (opts.disabled) btn.disabled = true;
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

function renderMetadata(content: HTMLElement, event: CalendarEvent, opts: MeetingCardOpts): void {
	const meta = content.createDiv({cls: "whisper-cal-card-meta"});

	if (event.onlineMeetingUrl) {
		const joinUrl = event.onlineMeetingUrl;
		// No href: Obsidian's own external-link handler would open it in the
		// browser in addition to (and regardless of) our deep-link handler.
		const locLink = meta.createEl("a", {
			cls: "whisper-cal-card-meta-item whisper-cal-card-meta-link",
			attr: {"aria-label": "Join online meeting"},
		});
		locLink.addEventListener("click", evt => {
			evt.preventDefault();
			void (async () => {
				const launched = await openMeetingUrl(joinUrl);
				// Auto-record: once the meeting app is up, kick off capture so the
				// user doesn't have to reach back to the card. Only when the launch
				// succeeded and a recording API is configured; startCardApiRecording
				// still confirms if the service is already mid-recording.
				const baseUrl = opts.recordingApiBaseUrl;
				if (launched && opts.automateMeeting && baseUrl) {
					const noteFile = opts.noteCreator.findNote(event);
					const notePath = noteFile ? noteFile.path : opts.noteCreator.getNotePath(event);
					const started = await startCardApiRecording(opts, notePath, baseUrl, false);
					// Tag the session with the app we just opened so stopping the
					// recording from WhisperCal can close it, disconnecting the user
					// from the call (see the Stop handler). null when the provider has
					// no identifiable desktop app — then there's nothing to close.
					const app = started ? meetingAppForUrl(joinUrl) : null;
					if (app) opts.cardUi.setRecordingLaunchedApp(notePath, app);
				}
			})();
		});
		const locIcon = locLink.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(locIcon, "map-pin");
		locLink.createSpan({text: event.location || "No location"});
		addActivateOnKey(locLink, "link");
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

/**
 * Open the meeting note, creating it first if it doesn't exist yet (unscheduled
 * events prompt for a name). Shared by the card title link, the rail's note/
 * summary segments, and the ⋯ menu's "Open note" item — the note-pill click
 * handler from the old pill row.
 */
async function openOrCreateNote(opts: MeetingCardOpts): Promise<void> {
	const {app, noteCreator, event, onNoteCreated} = opts;
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
	const {event, timezone, noteCreator, app} = opts;
	const card = container.createDiv({cls: "whisper-cal-card"});
	card.dataset.eventId = event.id;
	card.dataset.notePath = noteCreator.getNotePath(event);
	if (!event.isAllDay) {
		card.dataset.startTime = String(event.startTime.getTime());
		card.dataset.endTime = String(event.endTime.getTime());
	}

	renderGutter(card, event, timezone, opts);
	const content = card.createDiv({cls: "whisper-cal-card-content"});

	// Subject — the title itself opens (or creates) the meeting note. Static
	// zone, so the label can't track note state; use a state-neutral phrasing.
	const subjectRow = content.createDiv({cls: "whisper-cal-card-subject-row"});
	const subjectEl = subjectRow.createDiv({
		cls: "whisper-cal-card-subject whisper-cal-card-subject-link",
		text: event.subject,
		attr: {"aria-label": "Open or create meeting note"},
	});
	subjectEl.addEventListener("click", () => {
		void openOrCreateNote(opts);
	});
	addActivateOnKey(subjectEl);

	renderMetadata(content, event, opts);

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
			addActivateOnKey(link, "link");
		} else {
			orgEl.createSpan({text: event.organizerName});
		}
	}

	// Top-level unscheduled placeholder — mirrors the rail concept instead of a
	// bespoke button: a single pending Note segment whose click runs the same
	// create-note flow as a regular card's Note segment (openOrCreateNote
	// prompts for a name on unscheduled events). The other rail stages don't
	// apply to a stateless placeholder, so only Note is rendered. The expand
	// wrapper gives it the same hover-grow-into-labeled-bar behavior as the
	// full rail.
	if (event.id === "unscheduled") {
		const expandGroup = content.createDiv({cls: "whisper-cal-card-expand"});
		const rail = expandGroup.createDiv({cls: "whisper-cal-rail whisper-cal-rail-solo"});
		renderRailSeg(rail, "Note", "pending", () => { void openOrCreateNote(opts); });
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
): (msg: string | null, icon?: string, autoClearMs?: number, variant?: CardStatusVariant, badge?: string) => void {
	const {cardUi} = opts;
	return (msg, icon, autoClearMs, variant, badge) => {
		if (msg) {
			// Dedupe: polling flows re-issue the same status every tick (e.g.
			// "Transcribing…" every 3s from waitAndLink). An unchanged status must
			// not re-render — each rebuild resets the collapsed actions row, and
			// with the pointer resting on the card the :hover rule re-expands it,
			// so the card visibly snaps shut and reopens on every tick. Skipped
			// only for non-auto-clearing statuses; an auto-clear re-issue must
			// still write so its clear timer re-arms.
			const prev = cardUi.getStatus(notePath);
			if (!autoClearMs && prev && prev.message === msg && prev.icon === icon
				&& prev.variant === variant && prev.badge?.label === badge) {
				return;
			}
			cardUi.setStatus(notePath, {message: msg, icon, variant, ...(badge ? {badge: {label: badge}} : {})});
		} else {
			if (!cardUi.getStatus(notePath)) return;
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

/** Tear down a card's recording timer + status so a re-render can't resurrect them. */
function clearCardRecordingUi(opts: MeetingCardOpts, notePath: string): void {
	opts.cardUi.stopDurationTimer(notePath);
	opts.cardUi.deleteStartTime(notePath);
	opts.cardUi.deleteStatus(notePath);
	opts.onStatusUpdate?.();
}

/**
 * Start (or restart) an API recording for a card. Shared by the smart Record
 * button, the ⋯ menu's Re-record… item, and auto-record-on-launch. Confirms with
 * the user if the service is mid-recording, ensures the note exists, starts
 * capture, optionally resets stale transcript frontmatter, then watches for the
 * service to finish. Returns true if capture started.
 */
async function startCardApiRecording(
	opts: MeetingCardOpts,
	notePath: string,
	baseUrl: string,
	resetFrontmatter: boolean,
): Promise<boolean> {
	const {app, event, timezone, noteCreator, cardUi, transcriptFolderPath = "Transcripts"} = opts;
	// Defer to the recording service on whether the mic is free; confirm with
	// the user if it's mid-recording. Abort cleanly on cancel.
	if (!(await confirmIfServiceRecording(app, baseUrl))) return false;
	await noteCreator.ensureNote(event);
	await startApiRecording({app, notePath, event, transcriptFolderPath, timezone, baseUrl, cardUi});
	// Reset only once capture is underway — a failed start leaves the note's
	// existing transcript link intact.
	if (resetFrontmatter) {
		await removeFrontmatterKeys(app, notePath, [
			FM.TRANSCRIPT, FM.PIPELINE_STATE, FM.MACWHISPER_SESSION_ID,
		]);
	}
	watchApiRecording({
		app, notePath, transcriptFolderPath, baseUrl, cardUi,
		onStopped: () => clearCardRecordingUi(opts, notePath),
		onStatus: onStatusForCard(notePath, opts),
	});
	return true;
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

	// Keep dataset paths in sync with actual note/transcript paths so that
	// rerenderCardByPath lookups succeed even when the calendar event subject
	// diverges from the note filename (e.g. organizer renamed the meeting).
	cardEl.dataset.notePath = notePath;
	if (states.transcriptPath) {
		cardEl.dataset.transcriptPath = states.transcriptPath;
	} else {
		delete cardEl.dataset.transcriptPath;
	}

	// Mark cards with capture activity (recording underway or a transcript
	// already linked). When meetings overlap, the now-line uses this to run
	// through the meeting actually attended instead of an untouched sibling.
	cardEl.dataset.pipelineTouched =
		states.record === "running" || states.transcript === "complete" ? "1" : "0";

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

	const recordingApiBaseUrl = opts.recordingApiBaseUrl;
	const llmOn = opts.llmEnabled !== false;
	const {cardUi} = opts;

	// Tear down the recording timer + status so a re-render can't resurrect them.
	const clearRecordingUi = () => clearCardRecordingUi(opts, notePath);

	// Start (or restart) an API recording. Shared by the smart Record button and
	// the ⋯ menu's Re-record… item — they differ only in the pre-step the caller
	// runs first (orphan check vs. nothing) and whether the existing transcript
	// frontmatter is reset. startApiRecording's setRecording() fires a re-render
	// that rebuilds this card into its Stop state, so there's no manual button
	// bookkeeping here. Returns true if capture started.
	const beginCapture = (resetFrontmatter: boolean): Promise<boolean> =>
		recordingApiBaseUrl
			? startCardApiRecording(opts, notePath, recordingApiBaseUrl, resetFrontmatter)
			: Promise.resolve(false);

	// Reusable LLM-step launchers — the smart button and ⋯ menu share these.
	const runTagSpeakers = (tf: TFile) => {
		const transcriptFm = (app.metadataCache.getFileCache(tf)?.frontmatter ?? {}) as Record<string, unknown>;
		// Single-source recordings (voice memos, single-speaker diarization) often
		// capture more people than the mic suggests — the instructions modal
		// carries the hint prompt. Empty Run proceeds normally; cancel aborts.
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
			onTagSpeakers?.(tf, transcriptFm, notePath, instructions || undefined);
		})();
	};
	const runSummarize = (regen: boolean) => {
		void (async () => {
			const instructions = await new LlmInstructionsModal(app, {
				title: regen ? "Regenerate summary with instructions" : "Summarize with instructions",
				subtitle: event.subject,
			}).prompt();
			if (instructions === null) return; // cancelled
			onSummarize?.(notePath, regen, instructions || undefined);
		})();
	};

	// ⋯ menu — the labeled home for secondary actions, so the action row never
	// has to grow: new occasional actions become menu items. Opened by the ⋯
	// mini and by right-clicking the card body.
	const buildCardMenu = (): Menu => {
		const menu = new Menu();
		const tf = states.transcriptFile;

		menu.addItem((item) => item
			.setTitle(states.note === "complete" ? "Open note" : "Create note")
			.setIcon(states.note === "complete" ? "notebook-pen" : "file-plus-2")
			.onClick(() => { void openOrCreateNote(opts); }));

		if (tf) {
			menu.addItem((item) => item
				.setTitle("Open transcript")
				.setIcon("file-text")
				.onClick(() => { void app.workspace.openLinkText(tf.path, "", false); }));
		}

		if (llmOn && tf && opts.onReviewSpeakerCandidates && states.speakersCandidatesReady) {
			// Mirrors the smart Review speakers button so the menu stays a complete
			// inventory of the card's actions.
			menu.addItem((item) => item
				.setTitle("Review speaker candidates")
				.setIcon("user-round-check")
				.onClick(() => { opts.onReviewSpeakerCandidates?.(notePath); }));
		} else if (llmOn && tf && onTagSpeakers && states.speakers === "incomplete" && !states.speakersCandidatesReady) {
			menu.addItem((item) => item
				.setTitle("Tag speakers…")
				.setIcon("user-round-plus")
				.onClick(() => runTagSpeakers(tf)));
		} else if (llmOn && tf && opts.onReviewSpeakerCandidates && states.speakers === "complete") {
			// Edit the applied speaker tags — no LLM re-run; the modal opens
			// pre-filled with the current assignments so a name can be corrected.
			// Requires a resolvable transcript like its siblings — with a broken
			// transcript link there are no tags to edit.
			menu.addItem((item) => item
				.setTitle("Edit speaker tags")
				.setIcon("user-round-cog")
				.onClick(() => { opts.onReviewSpeakerCandidates?.(notePath); }));
		}

		// Summarize/regenerate goes through the instructions modal (empty Run =
		// plain run). Omitted while a summarize job runs.
		if (llmOn && onSummarize && (states.summary === "incomplete" || states.summary === "complete")) {
			const regen = states.summary === "complete";
			menu.addItem((item) => item
				.setTitle(regen ? "Regenerate summary…" : "Summarize meeting…")
				.setIcon(regen ? "refresh-cw" : "sparkles")
				.onClick(() => runSummarize(regen)));
		}

		// Research — independent of the transcript pipeline, re-runnable, and
		// auto-creates the parent note if it's missing.
		if (llmOn && onResearch) {
			if (states.research === "running") {
				menu.addItem((item) => item
					.setTitle("Researching…")
					.setIcon("book-open")
					.setDisabled(true));
			} else {
				menu.addItem((item) => item
					.setTitle("Research meeting…")
					.setIcon("book-open")
					.onClick(() => {
						void (async () => {
							const hadNote = noteFile !== null;
							const path = await noteCreator.ensureNote(event);
							if (!hadNote && onNoteCreated) onNoteCreated(event.id);
							onResearch(path);
						})();
					}));
			}
		}

		// Re-record… — moved here off the action row; only when a transcript
		// exists and the recording service is the active source. The record
		// check closes a transient: right after a re-record starts, the old
		// transcript link can still be in frontmatter while capture is live.
		if (states.transcript === "complete" && states.record !== "running" && recordingApiBaseUrl) {
			menu.addItem((item) => item
				.setTitle("Re-record…")
				.setIcon("mic")
				.onClick(() => {
					void (async () => {
						const choice = await new ReRecordConfirmModal(app, {
							pipelineState: states.pipelineState,
						}).prompt();
						if (choice === "view") {
							const tf2 = states.transcriptFile;
							if (tf2) void app.workspace.openLinkText(tf2.path, "", false);
						} else if (choice === "re-record") {
							try {
								await beginCapture(true);
							} catch (err) {
								new Notice(err instanceof Error ? err.message : "Failed to start recording");
							}
						}
					})();
				}));
		}

		// Export/delete need a note on disk — offered once one exists.
		if (states.note === "complete") {
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle("Export meeting bundle…")
				.setIcon("folder-output")
				.onClick(() => { void exportMeetingBundle(app, notePath); }));

			// Rename — offered alongside export/delete. Related files (transcript,
			// audio, voiceprint sidecar) are resolved up front and offered as an
			// opt-in bulk rename in the modal; the actual rename goes through
			// Obsidian's fileManager so every cross-vault link is rewritten.
			menu.addItem((item) => item
				.setTitle("Rename note…")
				.setIcon("pencil")
				.onClick(() => {
					if (!noteFile) return;
					void (async () => {
						const noteFm = (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {}) as Record<string, unknown>;
						const related = collectMeetingRelatedFiles(app, notePath, noteFm);
						const choice = await new RenameNoteModal(app, {
							currentName: noteFile.basename,
							relatedFiles: related,
						}).prompt();
						if (!choice) return; // cancelled or unchanged
						const {renamed} = await renameMeetingFiles(
							app,
							noteFile,
							choice.newName,
							choice.renameRelated ? related : [],
						);
						if (renamed > 0) new Notice(`Renamed ${renamed} file${renamed === 1 ? "" : "s"}`);
						opts.onNoteRenamed?.();
					})();
				}));

			// Delete — destructive, so it's rendered red (setWarning) and confirmed
			// through a dedicated modal. Hidden while a recording is live: capture is
			// still writing to this note, and trashing it mid-record would strand the
			// in-flight transcript link. Related files (transcript/audio/voiceprint
			// sidecar) are resolved up front — before anything is trashed — so they can
			// be listed in the modal and the note's links still resolve.
			if (states.record !== "running") {
				menu.addItem((item) => item
					.setTitle("Delete note…")
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => {
						if (!noteFile) return;
						void (async () => {
							const noteFm = (app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {}) as Record<string, unknown>;
							const related = collectMeetingRelatedFiles(app, notePath, noteFm);
							const choice = await new DeleteNoteModal(app, {
								subject: event.subject,
								relatedFiles: related,
							}).prompt();
							if (!choice) return; // cancelled
							const toTrash: TFile[] = [noteFile];
							if (choice.deleteRelated) toTrash.push(...related.map(r => r.file));
							const n = await trashMeetingFiles(app, toTrash);
							if (n > 0) new Notice(`Moved ${n} file${n === 1 ? "" : "s"} to trash`);
							opts.onNoteDeleted?.();
						})();
					}));
			}
		}

		return menu;
	};

	// Expand group — the status rail and the collapsible actions share one hover
	// container so auto-expand keys on the rail alone (not the whole card), while
	// still staying open when the pointer moves down onto the revealed buttons.
	// When collapsed the actions have zero height, so the only hover target is the
	// rail itself; see .whisper-cal-card-expand in styles.css.
	const expandGroup = zone.createDiv({cls: "whisper-cal-card-expand"});

	// Status rail — four segments (Note · Transcript · Speakers · Summary).
	// Rendered before the collapsible actions and always visible (the rail stays
	// shown even when collapsed). Each segment opens its stage's artifact on
	// click; hovering the rail expands the segments into labeled bars.
	const rail = expandGroup.createDiv({cls: "whisper-cal-rail"});

	// Activity badge — while a job runs (LLM or voiceprint), a blinking light +
	// one-word action label (with the LLM model name on a second line) rides in
	// the gutter, level with the rail. A child of the rail so it's absolutely
	// positioned against the rail's own row (projected leftward into the gutter
	// — see styles.css); together with the pulsing rail segment it replaces the
	// verbose status line.
	const badgeStatus = opts.cardUi.getStatus(notePath);
	// The badge hangs below the rail; this class buys the collapsed card the
	// extra height for it (see .whisper-cal-card-has-badge in styles.css) so
	// the bottom whitespace stays constant whether or not a badge is showing.
	cardEl.toggleClass("whisper-cal-card-has-badge", !!badgeStatus?.badge);
	if (badgeStatus?.badge) {
		// The variant class colors the light: progress = blinking red,
		// done = green, warning = orange (see styles.css).
		const badgeVariant = badgeStatus.variant ?? "progress";
		const badge = rail.createDiv({
			cls: `whisper-cal-rail-badge whisper-cal-rail-badge-${badgeVariant}`,
			attr: {"aria-label": badgeStatus.message},
		});
		badge.createDiv({cls: "whisper-cal-rail-badge-label", text: badgeStatus.badge.label});
		if (badgeStatus.badge.model) {
			badge.createDiv({cls: "whisper-cal-rail-badge-model", text: badgeStatus.badge.model});
		}
	}

	const openNote = states.note === "complete" ? () => { void openOrCreateNote(opts); } : undefined;
	const openTranscript = states.transcriptFile
		? () => { const tf = states.transcriptFile; if (tf) void app.workspace.openLinkText(tf.path, "", false); }
		: undefined;

	// The Note segment is clickable even on an unstarted card: clicking it
	// creates the note, same as the ⋯ menu's Create note (openOrCreateNote
	// handles both cases; unscheduled events prompt for a name). openNote
	// stays note-complete-gated for the Summary segment below, which must not
	// create a note from its pending state.
	// Research runs against the note (it's the Note stage's LLM action), so a
	// running research job pulses this segment. Keep the segment's own color —
	// green once the note exists — and pulse on top, rather than recoloring it to
	// the running accent; the note-created state shouldn't visually regress mid-run.
	const noteSeg: RailSegState = states.note === "complete" ? "done" : "pending";
	renderRailSeg(rail, "Note", noteSeg, () => { void openOrCreateNote(opts); },
		undefined, states.research === "running");

	let transcriptSeg: RailSegState;
	if (states.record === "running") transcriptSeg = "rec";
	else if (states.transcript === "complete") transcriptSeg = "done";
	else transcriptSeg = "pending";
	renderRailSeg(rail, "Transcript", transcriptSeg, openTranscript, "No transcript detected");

	let speakersSeg: RailSegState;
	if (states.speakersCandidatesReady) speakersSeg = "attention";
	else if (states.speakers === "running") speakersSeg = "running";
	else if (states.speakers === "complete") speakersSeg = "done";
	// Transcript is in and no job is queued — the pipeline is waiting on the
	// user to tag speakers (manually or by reviewing), so flag it, don't gray
	// it. Only when LLM features are on: with them off the pipeline ends at
	// the transcript and the card already reads as done.
	else if (states.speakers === "incomplete" && llmOn) speakersSeg = "attention";
	else speakersSeg = "pending";
	// Clicking Speakers acts on the segment's stage, not just the transcript:
	// cached candidates open the review modal; already-tagged speakers open the
	// same modal pre-filled with the applied decisions (the ⋯ menu's "Edit
	// speaker tags"), so a name can be corrected. Any other state falls back to
	// opening the transcript.
	const openSpeakers = llmOn && opts.onReviewSpeakerCandidates && states.transcriptFile
		&& (states.speakersCandidatesReady || states.speakers === "complete")
		? () => { opts.onReviewSpeakerCandidates?.(notePath); }
		: openTranscript;
	renderRailSeg(rail, "Speakers", speakersSeg, openSpeakers, "No transcript detected");

	let summarySeg: RailSegState;
	if (states.summary === "running") summarySeg = "running";
	else if (states.summary === "complete") summarySeg = "done";
	// Speakers are tagged and no job is queued — summarizing is the pipeline's
	// next step waiting on the user. Only when LLM features are on: without
	// them there is no summarize action, so gray is honest there.
	else if (states.summary === "incomplete" && llmOn) summarySeg = "attention";
	else summarySeg = "pending";
	renderRailSeg(rail, "Summary", summarySeg, openNote, "No note yet");

	// Celebrate completions with the relay vocabulary: a stage that just
	// flipped to done plays the one-shot fill on its own segment, and the
	// pipeline finishing end to end (Summary flipping) plays the full-rail
	// wave + shimmer — the finale the per-stage beats foreshadow. Flips are
	// detected against the previous render's flags; the first sighting of a
	// card only seeds the map. A summary regenerated after re-tagging resets
	// pipeline_state first, so it flips again and earns another wave.
	const done: [boolean, boolean, boolean, boolean] = [
		states.note === "complete",
		states.transcript === "complete",
		states.speakers === "complete",
		states.summary === "complete",
	];
	const now = Date.now();
	const cel = celebrations.get(notePath);
	if (cel) {
		const flipped = [0, 1, 2, 3].filter(i => done[i] && !cel.prevDone[i]);
		if (done[3] && flipped.includes(3)) {
			// End-to-end finish — the wave animates every segment, so it
			// supersedes any pending per-segment windows.
			cel.railUntil = now + CELEBRATION_WINDOW_MS;
			cel.segUntil = [0, 0, 0, 0];
		} else {
			// Left→right stagger when several stages land in one render,
			// matching the wave's beat.
			flipped.forEach((seg, order) => {
				cel.segUntil[seg] = now + CELEBRATION_WINDOW_MS;
				cel.segDelay[seg] = order * CELEBRATION_STAGGER_MS;
			});
		}
		// A stage that regressed (transcript unlinked, summary reset) stops
		// celebrating immediately.
		for (let i = 0; i < 4; i++) if (!done[i]) cel.segUntil[i] = 0;
		if (!done[3]) cel.railUntil = 0;
		cel.prevDone = done;
		if (cel.railUntil > now) {
			rail.addClass("whisper-cal-rail-complete");
		} else {
			const segEls = rail.querySelectorAll(".whisper-cal-rail-seg");
			for (let i = 0; i < 4; i++) {
				const el = segEls[i];
				if ((cel.segUntil[i] ?? 0) > now && el instanceof HTMLElement) {
					el.addClass("whisper-cal-rail-seg-complete");
					el.style.animationDelay = `${cel.segDelay[i] ?? 0}ms`;
				}
			}
		}
	} else {
		celebrations.set(notePath, {
			prevDone: done, railUntil: 0,
			segUntil: [0, 0, 0, 0], segDelay: [0, 0, 0, 0],
		});
	}

	// Actions row (wrapped for collapse animation)
	const actionsWrap = expandGroup.createDiv({cls: "whisper-cal-card-actions-wrap"});
	const actions = actionsWrap.createDiv({cls: "whisper-cal-card-actions"});

	// Smart action button — always the pipeline's next verb; absent when the
	// pipeline is complete. Priority order per the state machine.
	if (states.record === "running") {
		// 1 — recording in progress: red Stop button with a live timer.
		if (cardUi.getStartTime(notePath) === undefined) cardUi.setStartTime(notePath, Date.now());
		const stopBtn = actions.createEl("button", {
			cls: "whisper-cal-smart whisper-cal-smart-stop",
			attr: {"aria-label": "Stop recording"},
		});
		const ico = stopBtn.createSpan({cls: "whisper-cal-smart-icon"});
		setIcon(ico, "square");
		stopBtn.createSpan({cls: "whisper-cal-smart-label", text: "Stop · "});
		// Dedicated elapsed span — startDurationTimer writes the counter here.
		const elapsedEl = stopBtn.createSpan({cls: "whisper-cal-smart-elapsed"});
		startDurationTimer(cardUi, notePath, elapsedEl);
		stopBtn.addEventListener("click", () => {
			// stopApiRecording deletes the recording entry synchronously (before its
			// first await) → re-render to the Record button; clearRecordingUi then
			// tears down the timer/status so the final render can't resurrect them.
			stopBtn.disabled = true;
			// Read the launched app BEFORE stopApiRecording deletes the recording
			// state. Present only when auto-record-on-launch opened the app for this
			// session; closing it here disconnects the user from the call. When the
			// call instead ended app-side, the watch loop clears the state without
			// closing — so this fires only for stops initiated from WhisperCal.
			const launchedApp = cardUi.getRecording(notePath)?.launchedApp;
			if (recordingApiBaseUrl) {
				void stopApiRecording({app, notePath, transcriptFolderPath, baseUrl: recordingApiBaseUrl, cardUi, onStatus: onStatusForCard(notePath, opts)});
			}
			clearRecordingUi();
			if (launchedApp) {
				void closeMeetingApp(launchedApp);
				// The app disappearing on its own reads as a crash — say why.
				const appLabel = launchedApp === "teams" ? "Teams" : "Zoom";
				new Notice(`Closing ${appLabel} to leave the meeting`);
			}
		});
	} else if (states.transcript !== "complete") {
		// 2 — no transcript yet: Record (API) or Link recording (MacWhisper).
		if (recordingApiBaseUrl) {
			const recordBtn = renderSmartBtn(actions, "mic", "Record", {ariaLabel: "Record"});
			recordBtn.addEventListener("click", () => {
				recordBtn.disabled = true;
				void (async () => {
					let started = false;
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
							if (choice !== "re-record") return;
							// Defensive: clear any stale pipeline frontmatter that may
							// have been partially written before the link step failed.
							await removeFrontmatterKeys(app, notePath, [
								FM.TRANSCRIPT, FM.PIPELINE_STATE, FM.MACWHISPER_SESSION_ID,
							]);
						}
						started = await beginCapture(false);
					} catch (err) {
						new Notice(err instanceof Error ? err.message : "Failed to start recording");
					} finally {
						// A successful start re-renders the card (this button is gone);
						// on any non-start path, re-enable it.
						if (!started) recordBtn.disabled = false;
					}
				})();
			});
		} else {
			const linkBtn = renderSmartBtn(actions, "mic", "Link recording", {ariaLabel: "Link recording"});
			linkBtn.addEventListener("click", () => {
				linkBtn.disabled = true;
				void (async () => {
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
						if (!linked) linkBtn.disabled = false;
					}
				})();
			});
		}
	} else if (states.speakers === "running") {
		// 3 — speaker-tag job running.
		renderSmartBtn(actions, "users-round", "Tagging speakers…", {cls: "whisper-cal-smart-busy", disabled: true, ariaLabel: "Tagging speakers"});
	} else if (states.summary === "running") {
		// 4 — summarize job running.
		renderSmartBtn(actions, "sparkles", "Summarizing…", {cls: "whisper-cal-smart-busy", disabled: true, ariaLabel: "Summarizing"});
	} else if (llmOn && states.speakersCandidatesReady && opts.onReviewSpeakerCandidates) {
		// 5 — cached speaker candidates await review.
		const count = countCachedProposals(app, states.transcriptPath);
		const reviewBtn = renderSmartBtn(actions, "user-round-check", "Review speakers", {cls: "whisper-cal-smart-review", count, ariaLabel: "Review speakers"});
		reviewBtn.addEventListener("click", () => { opts.onReviewSpeakerCandidates?.(notePath); });
	} else if (llmOn && !states.speakersCandidatesReady && states.speakers === "incomplete" && onTagSpeakers && states.transcriptFile) {
		// 6 — speakers incomplete: manual Tag speakers step.
		const tf = states.transcriptFile;
		const tagBtn = renderSmartBtn(actions, "user-round-plus", "Tag speakers…", {ariaLabel: "Tag speakers"});
		tagBtn.addEventListener("click", () => runTagSpeakers(tf));
	} else if (llmOn && states.speakers === "complete" && states.summary === "incomplete" && onSummarize) {
		// 7 — speakers done, summary pending: manual Summarize step.
		const sumBtn = renderSmartBtn(actions, "sparkles", "Summarize meeting…", {ariaLabel: "Summarize meeting"});
		sumBtn.addEventListener("click", () => runSummarize(false));
	}
	// 8 — pipeline complete (or LLM off with a linked transcript): no button.

	// ⋯ mini — opens the secondary-actions menu; also bound to right-click on
	// the card body. Always available (its items adapt to state, and Open note/
	// Research create the note themselves).
	const moreMini = actions.createEl("button", {
		cls: "whisper-cal-mini",
		attr: {"aria-label": "More actions"},
	});
	const moreIco = moreMini.createSpan({cls: "whisper-cal-mini-icon"});
	setIcon(moreIco, "ellipsis");
	moreMini.addEventListener("click", () => {
		const rect = moreMini.getBoundingClientRect();
		buildCardMenu().showAtPosition({x: rect.left, y: rect.bottom + 4});
	});

	// Right-click anywhere on the card opens the same menu. Links keep
	// Obsidian's own context menu (instanceof Element, not HTMLElement —
	// setIcon targets inside a link are SVG), and an active text selection
	// keeps the native copy menu. Property assignment rather than
	// addEventListener — renderCardDynamic re-runs on every card update
	// and must replace the handler, not stack another.
	cardEl.oncontextmenu = (e) => {
		if (e.target instanceof Element && e.target.closest("a")) return;
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) return;
		e.preventDefault();
		buildCardMenu().showAtMouseEvent(e);
	};

	// Unified card status — renders from CardUiState. The recording variant is
	// skipped: while recording, the live timer lives inside the Stop button, not
	// a status line. Every other variant (transcribing progress, auto-tag
	// notices, done/warning) still renders here. Lives inside the expand group so
	// the group's fill-to-bottom growth adds trailing space below it, never a gap
	// between it and the action row above.
	const cs = opts.cardUi.getStatus(notePath);
	// Badge-carrying statuses (LLM jobs, voiceprint auto-tag) render as the
	// gutter badge above instead of a status line — the pulsing rail segment
	// already says what's running.
	if (cs && cs.variant !== "recording" && !cs.badge) {
		const variant = cs.variant ?? "progress";
		const statusEl = expandGroup.createDiv({cls: `whisper-cal-card-status whisper-cal-card-status-${variant}`});
		if (cs.icon) {
			const ico = statusEl.createSpan({cls: "whisper-cal-card-status-icon"});
			setIcon(ico, cs.icon);
		}
		statusEl.createSpan({text: cs.message});
	}

	// Cards rest collapsed and expand on hover — but pin one open while a
	// recording is live so the Stop button is never hidden. Other activity
	// (LLM jobs, voiceprint) announces itself via the gutter badge and the
	// pulsing rail segment instead of holding the card open.
	const pinned = states.record === "running";
	cardEl.toggleClass("whisper-cal-card-active", pinned);
}

/** Update only the dynamic parts of an existing meeting card in-place. */
export function updateMeetingCard(cardEl: HTMLElement, opts: MeetingCardOpts): void {
	const dynamicZone = cardEl.querySelector(".whisper-cal-card-dynamic");
	if (!(dynamicZone instanceof HTMLElement)) return;
	renderCardDynamic(dynamicZone, cardEl, opts);
}
