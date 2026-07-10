import {ItemView, Notice, TFile, TFolder, WorkspaceLeaf, setIcon} from "obsidian";
import {getMarkdownFilesRecursive} from "../utils/vault";
import {VIEW_TYPE_CALENDAR, FM} from "../constants";
import type {CalendarEvent, CalendarProvider} from "../types";
import type {WhisperCalSettings} from "../settings";
import type {CacheStatus} from "../services/CalendarCache";
import type {UnlinkedRecording, UnlinkedRecordingProvider} from "../services/UnlinkedRecordingProvider";
import {EventSuggestModal, type LinkableNote} from "./EventSuggestModal";
import {NameInputModal} from "./NameInputModal";
import {DeleteTranscriptModal} from "./DeleteTranscriptModal";
import {MergeConfirmModal} from "./MergeConfirmModal";
import {computeSmartMergeName, mergeMeetings, resolveMergeParts} from "../services/MeetingMerger";
import {NoteCreator} from "./NoteCreator";
import {renderAllDayCard, renderMeetingCard, updateMeetingCard, type MeetingCardOpts} from "./MeetingCard";
import type {JobTracker} from "../services/JobTracker";
import type {CardUiState} from "../services/CardUiState";
import {coerceFmDate, coerceFmTime, formatDate, formatDisplayDate, formatRecordingDuration, formatTime, getHour12, getTodayString, isSameDay, parseDateTime} from "../utils/time";
import {AuthError} from "../services/CalendarAuth";
import type {AuthState} from "../services/AuthTypes";
import {autoCreatePeopleNotes} from "../services/PeopleAutoCreate";
import {PeopleMatchService} from "../services/PeopleMatchService";
import {resolveRecordingApiBaseUrl, recordingStatus} from "../services/RecordingApi";
import {hasCachedProposals} from "../services/SpeakerTagParser";

export interface CalendarViewCallbacks {
	getCacheStatus: () => CacheStatus | null;
	getUserEmail: () => string;
	jobs: JobTracker;
	cardUi: CardUiState;
	onTagSpeakers: (transcriptFile: TFile, transcriptFm: Record<string, unknown>, notePath: string, customInstructions?: string) => void;
	onReviewSpeakerCandidates: (notePath: string) => void;
	onSummarize: (notePath: string, force?: boolean, customInstructions?: string) => void;
	onResearch: (notePath: string) => void;
	getAuthState: () => AuthState;
	onSignIn: () => Promise<void>;
	onCancelSignIn: () => void;
	onOpenSettings: () => void;
	subscribeAuthState: (listener: (state: AuthState) => void) => () => void;
	getUnlinkedProvider: () => UnlinkedRecordingProvider;
}

/**
 * Normalize a meeting/transcript name for fuzzy equality: drop a leading ISO date prefix
 * (note templates often prepend "{{date}} - ", which the calendar subject lacks), lowercase,
 * and collapse whitespace. Used to decide whether an unlinked transcript "obviously" belongs
 * to a calendar meeting.
 */
function normalizeMeetingName(s: string): string {
	return s
		.replace(/^\d{4}-\d{2}-\d{2}\s*[-–—]?\s*/, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

export class CalendarView extends ItemView {
	private settings: WhisperCalSettings;
	private provider: CalendarProvider;
	private callbacks: CalendarViewCallbacks;
	private noteCreator: NoteCreator;
	private contentContainer: HTMLElement | null = null;
	private currentDateString: string;
	private refreshTimerId: number | null = null;
	private lastRefreshTime = 0;
	private static readonly DEBOUNCE_MS = 2000;
	private selectedDate: Date;
	private cachedEvents: CalendarEvent[] | null = null;
	private cardRefreshTimer: number | null = null;
	private fmSnapshot = new Map<string, string>();
	private dateEl: HTMLElement | null = null;
	private todayBtn: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private noteOpenPath: string | null = null;
	private stickyHeaderEl: HTMLElement | null = null;
	private unlinkedEl: HTMLElement | null = null;
	private unlinkedCollapsed = true;
	private unlinkedGeneration = 0;
	private autoLinkInFlight = false;
	private autoLinkAttempted = new Set<string>();
	private nowLineTimerId: number | null = null;
	private cards = new Map<string, {el: HTMLElement; opts: MeetingCardOpts}>();
	private mergeSelection = new Set<string>();
	private mergeBarEl: HTMLElement | null = null;
	private pendingFmPaths = new Set<string>();
	private refreshGeneration = 0;
	private peopleMatchService: PeopleMatchService | null = null;
	private unsubscribeAuth: (() => void) | null = null;
	private unsubscribeRecordings: (() => void) | null = null;
	private authStatusEl: HTMLElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		settings: WhisperCalSettings,
		provider: CalendarProvider,
		callbacks: CalendarViewCallbacks,
	) {
		super(leaf);
		this.settings = settings;
		this.provider = provider;
		this.callbacks = callbacks;
		this.noteCreator = new NoteCreator(this.app, settings);
		this.currentDateString = getTodayString(settings.timezone);
		this.selectedDate = new Date();
	}

	getViewType(): string {
		return VIEW_TYPE_CALENDAR;
	}

	getDisplayText(): string {
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		return "WhisperCal";
	}

	getIcon(): string {
		return "calendar";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();

		const root = container.createDiv({cls: "whisper-cal-container"});

		// Sticky header — date nav + status pinned while events scroll
		this.stickyHeaderEl = root.createDiv({cls: "whisper-cal-sticky-header"});
		const stickyHeader = this.stickyHeaderEl;

		// Header
		const header = stickyHeader.createDiv({cls: "whisper-cal-header"});

		// Navigation row: [<] date [>]
		const nav = header.createDiv({cls: "whisper-cal-nav"});

		const prevBtn = nav.createEl("button", {cls: "whisper-cal-nav-btn clickable-icon", attr: {"aria-label": "Previous day"}});
		setIcon(prevBtn, "chevron-left");
		this.registerDomEvent(prevBtn, "click", () => this.navigateDay(-1));

		this.dateEl = nav.createDiv({
			cls: "whisper-cal-date",
			text: formatDisplayDate(this.selectedDate, this.settings.timezone),
		});

		const nextBtn = nav.createEl("button", {cls: "whisper-cal-nav-btn clickable-icon", attr: {"aria-label": "Next day"}});
		setIcon(nextBtn, "chevron-right");
		this.registerDomEvent(nextBtn, "click", () => this.navigateDay(1));

		// Today button (hidden when already viewing today)
		this.todayBtn = header.createDiv({cls: "whisper-cal-today-btn", text: "Today"});
		this.registerDomEvent(this.todayBtn, "click", () => this.navigateToToday());
		this.updateTodayButtonVisibility();

		// Status row: [dot] "Cached 5 min ago" [refresh] [settings]
		const statusRow = stickyHeader.createDiv({cls: "whisper-cal-status-row"});
		this.statusEl = statusRow.createDiv({cls: "whisper-cal-status whisper-cal-hidden"});

		// Refresh + settings buttons persist alongside the status text
		const statusActions = statusRow.createDiv({cls: "whisper-cal-status-actions"});
		const refreshBtn = statusActions.createEl("button", {cls: "whisper-cal-status-action clickable-icon", attr: {"aria-label": "Refresh calendar"}});
		setIcon(refreshBtn, "refresh-cw");
		this.registerDomEvent(refreshBtn, "click", () => { void this.refresh(); });

		const settingsBtn = statusActions.createEl("button", {cls: "whisper-cal-status-action clickable-icon", attr: {"aria-label": "Open settings"}});
		setIcon(settingsBtn, "settings");
		this.registerDomEvent(settingsBtn, "click", () => { this.callbacks.onOpenSettings(); });

		// Auth banner — shown when not signed in (persists above events)
		this.authStatusEl = stickyHeader.createDiv({cls: "whisper-cal-auth-inline whisper-cal-hidden"});
		this.renderAuthInline(this.callbacks.getAuthState());

		// Merge bar — lives in the sticky header so Obsidian's status bar
		// overlay (backlinks/word count) can never cover it
		this.mergeBarEl = stickyHeader.createDiv({cls: "whisper-cal-merge-bar whisper-cal-hidden"});

		// Content area
		this.contentContainer = root.createDiv({cls: "whisper-cal-content"});
		this.unlinkedEl = root.createDiv({cls: "whisper-cal-unlinked-section"});

		// Subscribe to auth state changes BEFORE initial refresh so we catch
		// state transitions (e.g. expired token → signed-out) that happen during it.
		this.unsubscribeAuth = this.callbacks.subscribeAuthState((state) => {
			if (state.status === "signed-in") {
				this.lastRefreshTime = 0;
				void this.refresh();
			}
			this.renderAuthInline(state);
		});

		// Initial load
		await this.refresh();

		// Re-render cards when a meeting note's frontmatter changes
		// (e.g. macwhisper_session_id added via title bar mic or command)
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (this.cachedEvents === null) return;
				if (!file.path.startsWith(this.settings.noteFolderPath + "/")
				&& !file.path.startsWith(this.settings.transcriptFolderPath + "/")) return;

				// Only re-render if card-relevant frontmatter actually changed
				const newKey = this.getFmKey(file.path);
				if (newKey === this.fmSnapshot.get(file.path)) return;
				this.fmSnapshot.set(file.path, newKey);

				this.pendingFmPaths.add(file.path);

				if (this.cardRefreshTimer !== null) {
					window.clearTimeout(this.cardRefreshTimer);
				}
				this.cardRefreshTimer = window.setTimeout(() => {
					this.cardRefreshTimer = null;
					const paths = new Set(this.pendingFmPaths);
					this.pendingFmPaths.clear();

					// If a new note appeared that no existing card owns,
					// re-render the full timeline so it's inserted at the
					// correct time position (e.g. ad hoc meeting just created).
					let hasNewNote = false;
					for (const p of paths) {
						if (p.startsWith(this.settings.noteFolderPath + "/") && !this.findCardByPath(p)) {
							hasNewNote = true;
							break;
						}
					}

					if (hasNewNote && this.cachedEvents) {
						this.renderEvents(this.cachedEvents);
					} else {
						this.updateCardsForPaths(paths);
					}
					void this.loadAndRenderUnlinkedSection();
				}, 500);
			}),
		);

		// Highlight card when its meeting note is the active file
		this.registerEvent(this.app.workspace.on("file-open", () => this.onActiveFileChanged()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onActiveFileChanged()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.updateNoteOpenHighlight()));

		// A capture starting/ending flips the recording card's own pill between its
		// "running" (stop) state and its normal state, so re-render on every change
		// to the recordings map. Driven off the map itself so every mutation path is
		// covered, including captures stopped from Tome's own UI or via the watch
		// loop. (Sibling cards are no longer gated on this — the record click
		// consults Tome's live /status instead.)
		this.unsubscribeRecordings = this.callbacks.cardUi.onRecordingsChange(() => this.rerenderCards());

		// Start auto-refresh
		this.startAutoRefresh();

		// Current-time marker — runs independently on its own 60s tick
		this.startNowLineTimer();
	}

	async onClose(): Promise<void> {
		this.stopAutoRefresh();
		this.stopNowLineTimer();
		this.unsubscribeAuth?.();
		this.unsubscribeAuth = null;
		this.unsubscribeRecordings?.();
		this.unsubscribeRecordings = null;
		this.authStatusEl = null;
		this.noteOpenPath = null;
		this.unlinkedEl = null;
		this.mergeBarEl = null;
		this.mergeSelection.clear();
		this.cards.clear();
		this.pendingFmPaths.clear();
		if (this.cardRefreshTimer !== null) {
			window.clearTimeout(this.cardRefreshTimer);
			this.cardRefreshTimer = null;
		}
	}

	async refresh(): Promise<void> {
		const now = Date.now();
		if (now - this.lastRefreshTime < CalendarView.DEBOUNCE_MS) {
			return;
		}
		this.lastRefreshTime = now;

		// A full refresh re-fetches the calendar, so give auto-link another shot with fresh
		// events. (High-frequency metadataCache-change passes keep this set to avoid re-fetch
		// storms — only an explicit refresh clears it.)
		this.autoLinkAttempted.clear();

		if (!this.contentContainer) return;

		// Check for midnight rollover — auto-advance only if viewing the old "today"
		const todayString = getTodayString(this.settings.timezone);
		if (todayString !== this.currentDateString) {
			const wasViewingToday = this.currentDateString ===
				new Intl.DateTimeFormat("en-CA", {
					timeZone: this.settings.timezone,
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
				}).format(this.selectedDate);
			this.currentDateString = todayString;
			if (wasViewingToday) {
				this.selectedDate = new Date();
				this.updateHeader();
			}
		}

		// Track generation so concurrent refreshes don't interleave
		const gen = ++this.refreshGeneration;

		// Release any stale recording lock before rendering so a leaked in-memory
		// entry doesn't keep every other card's record pill disabled.
		await this.reconcileRecordingLock();
		if (gen !== this.refreshGeneration) return;

		this.renderLoading();

		try {
			const events = await this.provider.fetchEvents(this.selectedDate, this.settings.timezone);
			// Abort if a newer refresh has started while we were awaiting
			if (gen !== this.refreshGeneration) return;
			if (events.length === 0) {
				// Check if we're truly disconnected with no cache
				const status = this.callbacks.getCacheStatus();
				if (status && !status.connected && status.fetchedAt === null) {
					this.renderError("Not signed in.");
					this.updateStatusIndicator();
					this.updateTodayButtonVisibility();
					void this.loadAndRenderUnlinkedSection();
					return;
				}
			}
			this.renderEvents(events);

			// Auto-create People notes for unmatched organizers (fire-and-forget)
			if (this.settings.autoCreatePeopleNotes && this.settings.peopleFolderPath && this.settings.peopleTemplatePath) {
				void autoCreatePeopleNotes(
					this.app,
					this.settings.peopleFolderPath,
					this.settings.peopleTemplatePath,
					events,
					this.callbacks.getUserEmail(),
				);
			}
		} catch (e) {
			// Abort if a newer refresh has started
			if (gen !== this.refreshGeneration) return;
			console.error("[WhisperCal] refresh error:", e);
			if (e instanceof AuthError) {
				this.renderError(e.message);
			} else {
				const detail = e instanceof Error ? e.message : String(e);
				this.renderError(`Failed to fetch calendar events: ${detail}`);
			}
		}

		this.updateStatusIndicator();
		this.updateTodayButtonVisibility();
		void this.loadAndRenderUnlinkedSection();
	}

	/**
	 * Self-heal a leaked recording entry. WhisperCal tracks active captures in an
	 * in-memory map (`cardUi.recordings`); an entry drives the recording card's
	 * "running" pill, its red dot, and the elapsed-time status. The watch loop
	 * normally deletes an entry the instant Tome leaves the "recording" state, but
	 * if that loop dies (or never cleaned up) the entry leaks and the card looks
	 * stuck "recording" until the plugin reloads.
	 *
	 * Tome's `/status` is authoritative for "is a capture active". When it reports
	 * anything other than "recording" but we still hold entries, those entries are
	 * stale — prune them. A short startup grace skips just-started recordings whose
	 * capture hasn't flipped Tome to "recording" yet.
	 */
	private async reconcileRecordingLock(): Promise<void> {
		if (this.settings.recordingSource !== "api") return;
		const cardUi = this.callbacks.cardUi;
		if (cardUi.recordingCount === 0) return;

		const baseUrl = resolveRecordingApiBaseUrl(this.settings.recordingApiBaseUrl);
		if (!baseUrl) return;

		let state: string;
		try {
			({state} = await recordingStatus(baseUrl));
		} catch {
			return; // Tome unreachable — leave entries; the watch loop owns that case
		}
		if (state === "recording") return; // genuine active capture — lock is valid

		const STARTUP_GRACE_MS = 10000;
		const now = Date.now();
		const stale: string[] = [];
		cardUi.forEachRecording((_info, notePath) => {
			const startedAt = cardUi.getStartTime(notePath);
			if (startedAt === undefined || now - startedAt > STARTUP_GRACE_MS) {
				stale.push(notePath);
			}
		});
		for (const notePath of stale) {
			cardUi.stopDurationTimer(notePath);
			cardUi.deleteStartTime(notePath);
			cardUi.deleteStatus(notePath);
			cardUi.deleteRecording(notePath);
			console.warn(`[WhisperCal] Reconciled stale recording lock for ${notePath} (Tome state=${state})`);
		}
	}

	updateSettings(settings: WhisperCalSettings, provider: CalendarProvider): void {
		this.settings = settings;
		this.provider = provider;
		this.noteCreator = new NoteCreator(this.app, settings);
		this.peopleMatchService = null; // invalidate — will be recreated on next render
		this.startAutoRefresh();
		this.lastRefreshTime = 0;
		void this.refresh();
	}

	rerenderCards(): void {
		if (this.cachedEvents === null) return;
		for (const eventId of this.cards.keys()) {
			this.rerenderCardById(eventId);
		}
		this.updateNowMarker();
	}

	rerenderCard(notePath: string): void {
		this.rerenderCardByPath(notePath);
		// An in-place re-render can change the card's height (the activity badge
		// adds a row) and its live rank — reposition the now-line immediately
		// rather than letting it sit at a stale pixel offset until the next tick.
		this.updateNowMarker();
	}

	private renderLoading(): void {
		if (!this.contentContainer) return;
		this.contentContainer.empty();
		this.contentContainer.createDiv({
			cls: "whisper-cal-loading",
			text: "Loading calendar...",
		});
	}

	private renderError(message: string): void {
		if (!this.contentContainer) return;
		this.contentContainer.empty();
		this.contentContainer.createDiv({
			cls: "whisper-cal-error",
			text: message,
		});
	}

	/** Render the persistent auth banner: sign-in button, device code, or hidden when signed in. */
	private renderAuthInline(state: AuthState): void {
		if (!this.authStatusEl) return;
		this.authStatusEl.empty();

		switch (state.status) {
		case "signed-out":
		case "error": {
			this.authStatusEl.removeClass("whisper-cal-hidden");
			const btn = this.authStatusEl.createEl("button", {
				cls: "whisper-cal-btn",
				text: "Sign in",
			});
			btn.addEventListener("click", () => {
				void this.callbacks.onSignIn();
			});
			break;
		}
		case "signing-in": {
			this.authStatusEl.removeClass("whisper-cal-hidden");
			this.authStatusEl.createDiv({
				cls: "whisper-cal-auth-label",
				text: state.message ?? "Signing in\u2026",
			});
			this.authStatusEl.createDiv({
				cls: "whisper-cal-auth-hint",
				text: "Waiting for authorization\u2026",
			});
			const cancelBtn = this.authStatusEl.createEl("button", {
				cls: "whisper-cal-btn whisper-cal-btn-secondary",
				text: "Cancel",
			});
			cancelBtn.addEventListener("click", () => {
				this.callbacks.onCancelSignIn();
			});
			break;
		}
		case "signed-in":
			this.authStatusEl.addClass("whisper-cal-hidden");
			break;
		}
	}

	private renderEvents(events: CalendarEvent[]): void {
		if (!this.contentContainer) return;
		// Backfill isOrganizer for cached events that predate the field
		const userEmail = this.callbacks.getUserEmail()?.toLowerCase() ?? "";
		if (userEmail) {
			for (const e of events) {
				if (!e.isOrganizer && e.organizerEmail) {
					e.isOrganizer = e.organizerEmail.toLowerCase() === userEmail;
				}
			}
		}
		this.cachedEvents = events;
		this.contentContainer.empty();
		this.cards.clear();

		// Full re-render invalidates merge selection (cards are rebuilt)
		this.mergeSelection.clear();
		this.contentContainer.removeClass("whisper-cal-merge-active");
		this.updateMergeBar();

		const isToday = isSameDay(this.selectedDate, new Date(), this.settings.timezone);

		// Unscheduled card — always at the top
		const unscheduledEvent: CalendarEvent = {
			id: "unscheduled",
			subject: this.settings.unscheduledSubject || "Unscheduled Meeting",
			body: "",
			isAllDay: false,
			isOnlineMeeting: false,
			onlineMeetingUrl: "",
			startTime: this.selectedDate,
			endTime: this.selectedDate,
			location: "",
			attendeeCount: 0,
			attendees: [],
			organizerName: "",
			organizerEmail: "",
			isOrganizer: false,
			isRecurring: false,
			seriesId: "",
			responseStatus: "organizer",
			categories: [],
		};
		this.renderAndStoreCard(this.contentContainer, unscheduledEvent);
		this.contentContainer.createDiv({cls: "whisper-cal-adhoc-divider"});

		// Merge notes not backed by a Graph API event into the timeline
		// (covers "unscheduled", "macwhisper-*", and any other local-only notes).
		// Merged before the empty check so ad-hoc notes still render on days
		// with no calendar events (e.g. weekends).
		const calendarEventIds = new Set(events.map(e => e.id));
		const {localNotes, suppressedEventIds} = this.findLocalNotes(calendarEventIds);
		// Drop Graph events whose note was merged away (their merged card renders instead).
		const merged = [...events.filter(e => !suppressedEventIds.has(e.id)), ...localNotes];

		if (merged.length === 0) {
			this.contentContainer.createDiv({
				cls: "whisper-cal-empty",
				text: isToday ? "No meetings today" : "No meetings",
			});
			return;
		}

		const allDay = this.settings.showAllDayEvents ? merged.filter(e => e.isAllDay) : [];
		const timed = merged.filter(e => !e.isAllDay);
		timed.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

		if (allDay.length > 0) {
			for (const event of allDay) {
				const el = renderAllDayCard(this.contentContainer, event, {
					importantOrganizerEmails: this.settings.importantOrganizers.map(o => o.email),
				});
				this.cards.set(event.id, {el, opts: this.buildCardOpts(event)});
			}
		}

		if (timed.length > 0) {
			// Group overlapping events into conflict clusters
			const groups: CalendarEvent[][] = [];
			let cur: CalendarEvent[] = [timed[0]!];
			let curEnd = timed[0]!.endTime.getTime();

			for (let i = 1; i < timed.length; i++) {
				const event = timed[i]!;
				if (event.startTime.getTime() < curEnd) {
					cur.push(event);
					curEnd = Math.max(curEnd, event.endTime.getTime());
				} else {
					groups.push(cur);
					cur = [event];
					curEnd = event.endTime.getTime();
				}
			}
			groups.push(cur);

			for (let g = 0; g < groups.length; g++) {
				const group = groups[g]!;

				// Gap spacer between groups
				if (g > 0) {
					const prevGroup = groups[g - 1]!;
					const prevEnd = Math.max(...prevGroup.map(e => e.endTime.getTime()));
					const gapMs = group[0]!.startTime.getTime() - prevEnd;
					const gapText = formatRecordingDuration(Math.round(gapMs / 1000));
					if (gapText) {
						const spacer = this.contentContainer.createDiv({cls: "whisper-cal-gap"});
						spacer.dataset.gapStart = String(prevEnd);
						spacer.dataset.gapEnd = String(group[0]!.startTime.getTime());
						spacer.createDiv({cls: "whisper-cal-gap-line"});
						spacer.createDiv({cls: "whisper-cal-gap-label", text: gapText});
						spacer.createDiv({cls: "whisper-cal-gap-line"});
					}
				}

				// Wrap conflicts in a bracket container
				const isConflict = group.length > 1;
				const target = isConflict
					? this.contentContainer.createDiv({cls: "whisper-cal-conflict-group"})
					: this.contentContainer;

				if (isConflict) {
					const overlapStart = formatTime(group[0]!.startTime, this.settings.timezone);
					const overlapEnd = formatTime(
						new Date(Math.min(...group.map(e => e.endTime.getTime()))),
						this.settings.timezone,
					);
					const banner = target.createDiv({cls: "whisper-cal-conflict-banner"});
					setIcon(banner.createSpan({cls: "whisper-cal-conflict-banner-icon"}), "alert-triangle");
					banner.createSpan({
						text: `${group.length} meetings overlap at ${overlapStart} \u2013 ${overlapEnd}`,
					});
				}

				for (const event of group) {
					this.renderAndStoreCard(target, event);
				}
			}
		}

		// Reset so updateNoteOpenHighlight re-applies to the new DOM
		this.noteOpenPath = null;
		this.applyNoteOpenHighlight();

		// Snapshot frontmatter so the changed handler can detect real changes
		this.snapshotFrontmatter();

		// The container was emptied above, taking the now-line with it — every
		// renderEvents caller needs the marker re-placed, so do it here rather
		// than relying on each call site (or the next minute tick).
		this.updateNowMarker();
	}

	private getOrCreatePeopleMatchService(): PeopleMatchService | undefined {
		if (!this.settings.peopleFolderPath) return undefined;
		if (!this.peopleMatchService) {
			this.peopleMatchService = new PeopleMatchService(this.app, this.settings.peopleFolderPath);
		}
		return this.peopleMatchService;
	}

	private buildCardOpts(event: CalendarEvent): MeetingCardOpts {
		return {
			event,
			timezone: this.settings.timezone,
			noteCreator: this.noteCreator,
			app: this.app,
			jobs: this.callbacks.jobs,
			cardUi: this.callbacks.cardUi,
			transcriptFolderPath: this.settings.transcriptFolderPath,
			recordingWindowMinutes: this.settings.recordingWindowMinutes,
			importantOrganizerEmails: this.settings.importantOrganizers.map(o => o.email),
			llmEnabled: this.settings.llmEnabled,
			recordingApiBaseUrl: this.settings.recordingSource === "api"
				? resolveRecordingApiBaseUrl(this.settings.recordingApiBaseUrl) || undefined
				: undefined,
			automateMeeting: this.settings.recordingSource === "api" && this.settings.automateMeetingRecording,
			peopleMatchService: this.getOrCreatePeopleMatchService(),
			onNoteCreated: (eventId: string) => this.rerenderCardById(eventId),
			onTagSpeakers: this.callbacks.onTagSpeakers,
			onReviewSpeakerCandidates: this.callbacks.onReviewSpeakerCandidates,
			onSummarize: this.callbacks.onSummarize,
			onResearch: this.callbacks.onResearch,
			onNoteDeleted: () => {
				// Re-render from cache so the timeline reflects the deletion: a
				// local-only note's card disappears, while a Graph-backed note's card
				// falls back to its "create note" state. Also refresh the unlinked
				// section in case a now-orphaned recording should surface there.
				if (this.cachedEvents) this.renderEvents(this.cachedEvents);
				void this.loadAndRenderUnlinkedSection();
			},
			onNoteRenamed: () => {
				// Re-render from cache so every card picks up the note's new path
				// (and, when related files moved, the refreshed transcript links).
				if (this.cachedEvents) this.renderEvents(this.cachedEvents);
				void this.loadAndRenderUnlinkedSection();
			},
			onStatusUpdate: () => this.rerenderCardById(event.id),
			isMergeSelected: () => this.mergeSelection.has(event.id),
			onToggleMergeSelect: (selected: boolean) => {
				if (selected) this.mergeSelection.add(event.id);
				else this.mergeSelection.delete(event.id);
				this.contentContainer?.toggleClass("whisper-cal-merge-active", this.mergeSelection.size > 0);
				this.updateMergeBar();
			},
		};
	}

	private renderAndStoreCard(container: HTMLElement, event: CalendarEvent): void {
		const opts = this.buildCardOpts(event);
		const el = renderMeetingCard(container, opts);
		this.cards.set(event.id, {el, opts});
	}

	/** Update only the dynamic parts of a single card (pills, status, gutter highlight). */
	private rerenderCardById(eventId: string): void {
		const card = this.cards.get(eventId);
		if (!card) return;
		updateMeetingCard(card.el, card.opts);
	}

	/** Re-render only the cards affected by a set of changed file paths. */
	private updateCardsForPaths(paths: Set<string>): void {
		let updated = false;
		for (const [eventId, {el}] of this.cards) {
			if ((el.dataset.notePath && paths.has(el.dataset.notePath))
				|| (el.dataset.transcriptPath && paths.has(el.dataset.transcriptPath))) {
				this.rerenderCardById(eventId);
				updated = true;
			}
		}
		// A re-render can change a card's height (status lines come and go) and its
		// live rank (recording started/stopped) — reposition the now-line to match
		// instead of waiting for the next minute tick.
		if (updated) this.updateNowMarker();
	}

	/** Find the card whose note or transcript matches a file path, and re-render it. */
	private rerenderCardByPath(filePath: string): void {
		for (const [eventId, {el}] of this.cards) {
			if (el.dataset.notePath === filePath || el.dataset.transcriptPath === filePath) {
				this.rerenderCardById(eventId);
				return;
			}
		}
	}

	/**
	 * Find meeting notes for the selected date that aren't backed by a
	 * Graph API calendar event.  Covers "unscheduled", "macwhisper-*",
	 * merged (`_merged`) notes, and any other locally-created meeting notes.
	 *
	 * Also returns `suppressedEventIds`: the calendar_event_id of every note
	 * that has been merged away (`merged_into` set). renderEvents filters the
	 * Graph event list by this set so the original's card disappears in favor
	 * of the merged card — without ever moving or deleting the original file.
	 */
	private findLocalNotes(calendarEventIds: Set<string>): {localNotes: CalendarEvent[]; suppressedEventIds: Set<string>} {
		const suppressedEventIds = new Set<string>();
		const datePrefix = formatDate(this.selectedDate, this.settings.timezone);
		const folder = this.app.vault.getAbstractFileByPath(this.settings.noteFolderPath);
		if (!(folder instanceof TFolder)) return {localNotes: [], suppressedEventIds};

		const files = getMarkdownFilesRecursive(folder);
		const results: CalendarEvent[] = [];
		for (const child of files) {
			if (!child.basename.startsWith(datePrefix)) continue;

			const cache = this.app.metadataCache.getFileCache(child);
			const fm = cache?.frontmatter;
			if (!fm) continue;

			const eventId = fm[FM.CALENDAR_EVENT_ID] as string | undefined;

			// A merged-away original never renders its own card. Record its
			// (real) event id so the underlying Graph card is filtered too.
			if (fm[FM.MERGED_INTO]) {
				if (eventId) suppressedEventIds.add(eventId);
				continue;
			}

			if (!eventId || calendarEventIds.has(eventId)) continue;

			// Skip notes from a different provider (or legacy notes without the field)
			const noteProvider = fm["calendar_provider"] as string | undefined;
			if (noteProvider !== this.settings.calendarProvider) continue;

			// Parse meeting_start from frontmatter (e.g. "9:30 AM" or "16:39")
			// YAML may parse unquoted times as sexagesimal numbers (16:39 → 999)
			// and dates as Date objects, so normalize before matching.
			const meetingStart = coerceFmTime(fm["meeting_start"]);
			const meetingDate = coerceFmDate(fm["meeting_date"]);
			const meetingSubject = fm["meeting_subject"] as string | undefined;

			const meetingEnd = coerceFmTime(fm["meeting_end"]);

			let startTime: Date;
			if (meetingDate && meetingStart) {
				const parsed = parseDateTime(meetingDate, meetingStart);
				startTime = parsed ?? this.selectedDate;
			} else {
				startTime = this.selectedDate;
			}

			let endTime = startTime;
			if (meetingDate && meetingEnd) {
				const parsed = parseDateTime(meetingDate, meetingEnd);
				if (parsed) endTime = parsed;
			}

			// Prefer basename over frontmatter subject (user may rename the
			// note). Tolerate either separator after the date prefix —
			// "YYYY-MM-DD - Subject" (template-created) or "YYYY-MM-DD Subject"
			// (verbatim names from the link-unlinked-transcript flow).
			const isMerged = eventId.startsWith("merged-");
			let strippedBasename = child.basename.replace(/^\d{4}-\d{2}-\d{2}\s*-?\s*/, "");
			// Merged notes carry a `_merged` file suffix; drop it so the card
			// shows the clean user-chosen name.
			if (isMerged) strippedBasename = strippedBasename.replace(/_merged$/, "");
			const displaySubject = strippedBasename || meetingSubject || child.basename;

			results.push({
				// Merged notes key on their own synthetic id so findNote resolves
				// them deterministically (calendar_event_id === event.id).
				id: isMerged ? eventId : `unscheduled-${child.path}`,
				subject: displaySubject,
				body: "",
				isAllDay: false,
				isOnlineMeeting: false,
				onlineMeetingUrl: "",
				startTime,
				endTime,
				location: "",
				attendeeCount: 0,
				attendees: [],
				organizerName: "",
				organizerEmail: "",
				isOrganizer: false,
				isRecurring: false,
				seriesId: "",
				responseStatus: "organizer",
				categories: [],
				isMerged,
			});
		}
		return {localNotes: results, suppressedEventIds};
	}

	/** Find card whose note or transcript matches the given path. */
	private findCardByPath(path: string): HTMLElement | null {
		const escaped = CSS.escape(path);
		const selector = `[data-note-path="${escaped}"], [data-transcript-path="${escaped}"]`;
		for (const container of [this.contentContainer, this.unlinkedEl]) {
			const el = container?.querySelector(selector);
			if (el instanceof HTMLElement) return el;
		}
		return null;
	}

	private updateNoteOpenHighlight(): void {
		if (!this.contentContainer) return;
		const activePath = this.app.workspace.getActiveFile()?.path ?? null;
		if (activePath === this.noteOpenPath) return;

		const cls = "whisper-cal-card-note-open";

		// Remove from previous
		if (this.noteOpenPath !== null) {
			this.findCardByPath(this.noteOpenPath)?.removeClass(cls);
		}

		// Add to current
		if (activePath !== null) {
			this.findCardByPath(activePath)?.addClass(cls);
		}

		this.noteOpenPath = activePath;
	}

	/** Apply highlight to freshly-built DOM (no early-return guard). */
	private applyNoteOpenHighlight(): void {
		if (!this.contentContainer) return;
		const activePath = this.app.workspace.getActiveFile()?.path ?? null;
		const cls = "whisper-cal-card-note-open";

		if (activePath !== null) {
			this.findCardByPath(activePath)?.addClass(cls);
		}

		this.noteOpenPath = activePath;
	}

	private onActiveFileChanged(): void {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || !this.contentContainer) {
			this.updateNoteOpenHighlight();
			return;
		}

		// Only navigate for actual meeting notes
		const fm = this.app.metadataCache.getFileCache(activeFile)?.frontmatter;
		const meetingDate = fm?.["meeting_date"] as string | undefined;
		if (!meetingDate || !activeFile.path.startsWith(this.settings.noteFolderPath + "/")) {
			this.updateNoteOpenHighlight();
			return;
		}

		// If viewing a different day, navigate to the note's day
		const displayedDate = formatDate(this.selectedDate, this.settings.timezone);
		if (meetingDate !== displayedDate) {
			const [y, m, d] = meetingDate.split("-").map(Number);
			if (!isNaN(y as number) && !isNaN(m as number) && !isNaN(d as number)) {
				this.selectedDate = new Date(y as number, (m as number) - 1, d as number);
				this.lastRefreshTime = 0;
				this.updateHeader();
				void this.refresh();
				return; // renderEvents → updateNoteOpenHighlight handles highlight + scroll
			}
		}

		this.updateNoteOpenHighlight();
	}

	/** Show the floating merge bar when two or more cards are selected. */
	private updateMergeBar(): void {
		if (!this.mergeBarEl) return;
		const n = this.mergeSelection.size;
		this.mergeBarEl.empty();
		this.mergeBarEl.toggleClass("whisper-cal-hidden", n < 2);
		if (n < 2) return;

		this.mergeBarEl.createSpan({
			cls: "whisper-cal-merge-bar-text",
			text: `${n} meetings selected`,
		});
		const btns = this.mergeBarEl.createDiv({cls: "whisper-cal-merge-bar-btns"});

		const mergeBtn = btns.createEl("button", {
			cls: "whisper-cal-btn whisper-cal-btn-small mod-cta",
			text: "Merge",
		});
		mergeBtn.addEventListener("click", () => {
			mergeBtn.disabled = true;
			void this.handleMergeSelected().finally(() => {
				mergeBtn.disabled = false;
			});
		});

		const clearBtn = btns.createEl("button", {
			cls: "whisper-cal-btn whisper-cal-btn-small",
			text: "Clear",
		});
		clearBtn.addEventListener("click", () => this.clearMergeSelection());
	}

	private clearMergeSelection(): void {
		this.mergeSelection.clear();
		if (this.contentContainer) {
			this.contentContainer.removeClass("whisper-cal-merge-active");
			// Checkboxes live in the static card zone, so uncheck them directly
			const checked = this.contentContainer.querySelectorAll<HTMLInputElement>(".whisper-cal-merge-checkbox:checked");
			for (const cb of Array.from(checked)) cb.checked = false;
		}
		this.updateMergeBar();
	}

	private async handleMergeSelected(): Promise<void> {
		const notePaths: string[] = [];
		for (const id of this.mergeSelection) {
			const path = this.cards.get(id)?.el.dataset.notePath;
			if (path && !notePaths.includes(path)) notePaths.push(path);
		}

		const parts = resolveMergeParts(this.app, notePaths);
		if (parts.length < 2) {
			new Notice("Select at least two meetings with notes to merge");
			return;
		}

		const name = await new MergeConfirmModal(this.app, {
			parts,
			defaultName: computeSmartMergeName(parts),
			timezone: this.settings.timezone,
		}).prompt();
		if (!name) return;

		try {
			const result = await mergeMeetings(this.app, this.settings, parts, name);
			const mergedName = result.mergedNotePath.split("/").pop()?.replace(/\.md$/, "") ?? name;
			new Notice(`Merged ${parts.length} meetings into "${mergedName}"`);
			this.clearMergeSelection();
			if (this.cachedEvents) this.renderEvents(this.cachedEvents);
			void this.loadAndRenderUnlinkedSection();
		} catch (e) {
			console.error("[WhisperCal] Merge meetings error:", e);
			new Notice(`Failed to merge meetings: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async loadAndRenderUnlinkedSection(): Promise<void> {
		if (!this.unlinkedEl) return;
		this.unlinkedEl.empty();

		if (this.settings.unlinkedLookbackDays <= 0) return;

		const gen = ++this.unlinkedGeneration;
		const provider = this.callbacks.getUnlinkedProvider();

		const unlinked = await provider.findUnlinked(
			this.settings.unlinkedLookbackDays,
		);

		// Bail if a newer call superseded us
		if (gen !== this.unlinkedGeneration) return;

		// Auto-link the obvious ones first (e.g. a pill recording that Tome named but that was
		// never linked because it was stopped from Tome's own UI or Obsidian reloaded mid-record)
		// so the user only sees recordings that genuinely need a manual decision.
		const autoLinked = await this.autoLinkObvious(unlinked);
		if (gen !== this.unlinkedGeneration) return;
		const pending = autoLinked.size > 0 ? unlinked.filter(r => !autoLinked.has(r.id)) : unlinked;
		if (autoLinked.size > 0) {
			new Notice(`Auto-linked ${autoLinked.size} transcript${autoLinked.size === 1 ? "" : "s"} to ${autoLinked.size === 1 ? "its meeting" : "their meetings"}`);
		}

		if (pending.length === 0) {
			this.unlinkedEl.createDiv({
				cls: "whisper-cal-unlinked-empty",
				text: `No unlinked transcripts for the last ${this.settings.unlinkedLookbackDays} days`,
			});
			return;
		}

		// Collapsible header
		const header = this.unlinkedEl.createDiv({cls: "whisper-cal-unlinked-header"});
		const arrow = header.createSpan({cls: "whisper-cal-unlinked-arrow", text: this.unlinkedCollapsed ? "\u25B8" : "\u25BE"});
		header.createSpan({text: `Unlinked transcripts (${pending.length})`});

		const body = this.unlinkedEl.createDiv({cls: "whisper-cal-unlinked-body"});
		body.toggleClass("whisper-cal-hidden", this.unlinkedCollapsed);

		header.addEventListener("click", () => {
			this.unlinkedCollapsed = !this.unlinkedCollapsed;
			arrow.textContent = this.unlinkedCollapsed ? "\u25B8" : "\u25BE";
			body.toggleClass("whisper-cal-hidden", this.unlinkedCollapsed);
		});

		for (const recording of pending) {
			this.renderUnlinkedCard(body, recording);
		}

		// Freshly-built DOM — re-apply the active-note highlight
		this.applyNoteOpenHighlight();
	}

	/**
	 * Best-effort: link unlinked transcripts to an obviously-corresponding calendar meeting
	 * without bugging the user. Conservative by design — see findObviousMeeting — and never
	 * creates or opens a note (background passes must not steal editor focus). Returns the ids
	 * it linked so the caller can drop them from the rendered list. Works for any provider via
	 * the shared linkToNote interface.
	 */
	private async autoLinkObvious(unlinked: UnlinkedRecording[]): Promise<Set<string>> {
		const linked = new Set<string>();
		// One pass at a time: linking writes frontmatter, which re-triggers this loader.
		if (this.autoLinkInFlight) return linked;
		this.autoLinkInFlight = true;
		try {
			const unlinkedProvider = this.callbacks.getUnlinkedProvider();
			for (const rec of unlinked) {
				if (this.autoLinkAttempted.has(rec.id)) continue;
				this.autoLinkAttempted.add(rec.id);

				const event = await this.findObviousMeeting(rec, unlinkedProvider);
				if (!event) continue;

				const noteFile = this.noteCreator.findNote(event);
				if (!noteFile) continue; // note vanished between match and link
				try {
					const ok = await unlinkedProvider.linkToNote({
						app: this.app,
						recording: rec,
						notePath: noteFile.path,
						subject: event.subject,
						timezone: this.settings.timezone,
						transcriptFolderPath: this.settings.transcriptFolderPath,
						attendees: event.attendees,
						isRecurring: event.isRecurring,
						meetingDate: formatDate(event.startTime, this.settings.timezone),
						meetingStart: formatTime(event.startTime, this.settings.timezone),
						meetingEnd: formatTime(event.endTime, this.settings.timezone),
						organizer: event.organizerName,
						location: event.location,
					});
					if (ok) {
						linked.add(rec.id);
						console.debug(`[WhisperCal] Auto-linked transcript "${rec.title}" → "${event.subject}"`);
					}
				} catch (e) {
					console.warn(`[WhisperCal] auto-link failed for "${rec.title}":`, e);
				}
			}
		} finally {
			this.autoLinkInFlight = false;
		}
		return linked;
	}

	/**
	 * Return the single calendar meeting an unlinked recording obviously belongs to, or null
	 * when it's ambiguous (leave those for the user). "Obvious" requires ALL of:
	 *  - exactly one matching event within the recording time window,
	 *  - the event subject agreeing by name with the transcript title, and
	 *  - that event's meeting note already existing and not already linked.
	 * The existing-note requirement keeps this safe and focus-free: it never fabricates a note,
	 * and it cleanly recovers the common failure (a pill recording whose link step never ran).
	 */
	private async findObviousMeeting(
		rec: UnlinkedRecording,
		unlinkedProvider: UnlinkedRecordingProvider,
	): Promise<CalendarEvent | null> {
		const recName = normalizeMeetingName(rec.title);
		if (recName.length < 4) return null; // too generic to match safely

		let events: CalendarEvent[];
		try {
			events = await this.provider.fetchEvents(rec.recordingStart, this.settings.timezone);
		} catch {
			// Calendar unavailable — don't mark this a permanent miss; a later refresh retries.
			this.autoLinkAttempted.delete(rec.id);
			return null;
		}

		const windowMs = this.settings.recordingWindowMinutes * 60 * 1000;
		const matches: CalendarEvent[] = [];
		for (const e of events) {
			if (e.isAllDay) continue;
			if (Math.abs(e.startTime.getTime() - rec.recordingStart.getTime()) > windowMs) continue;
			const subj = normalizeMeetingName(e.subject);
			// Names must clearly agree: equal, or the transcript title ends with the subject
			// (note basenames may carry a "{{date}} - " prefix the calendar subject lacks).
			if (subj.length < 4 || (recName !== subj && !recName.endsWith(subj))) continue;
			// Only ever link to a note that already exists and isn't already linked.
			const noteFile = this.noteCreator.findNote(e);
			if (!noteFile) continue;
			const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
			if (unlinkedProvider.isNoteLinked((fm as Record<string, unknown>) ?? {})) continue;
			matches.push(e);
		}
		return matches.length === 1 ? matches[0]! : null;
	}

	private renderUnlinkedCard(container: HTMLElement, recording: UnlinkedRecording): void {
		const card = container.createDiv({cls: "whisper-cal-unlinked-card"});
		if (recording.transcriptPath) {
			card.dataset.transcriptPath = recording.transcriptPath;
		}

		const title = recording.title || "Untitled recording";
		card.createDiv({cls: "whisper-cal-unlinked-title", text: title});

		const meta = card.createDiv({cls: "whisper-cal-unlinked-meta"});
		const dateStr = this.formatRecordingDate(recording.recordingStart);
		const durStr = formatRecordingDuration(recording.durationSeconds);
		const parts = [dateStr];
		if (durStr) parts.push(durStr);
		if (recording.speakerCount > 0) parts.push(`${recording.speakerCount} speaker${recording.speakerCount === 1 ? "" : "s"}`);
		meta.createSpan({text: parts.join(" \u00B7 ")});

		const btns = meta.createSpan({cls: "whisper-cal-unlinked-btns"});

		// View first — reviewing a recording before linking it is the common flow
		if (recording.transcriptPath) {
			const viewBtn = btns.createEl("button", {cls: "whisper-cal-btn whisper-cal-btn-small", text: "View"});
			viewBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.app.workspace.openLinkText(recording.transcriptPath!, "", false);
			});
		}

		const linkBtn = btns.createEl("button", {cls: "whisper-cal-btn whisper-cal-btn-small", text: "Link"});
		linkBtn.addEventListener("click", () => {
			linkBtn.disabled = true;
			void this.handleLinkUnlinked(recording, card).finally(() => {
				linkBtn.disabled = false;
			});
		});

		const deleteBtn = btns.createEl("button", {cls: "whisper-cal-btn whisper-cal-btn-small whisper-cal-btn-danger", text: "Delete"});
		deleteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.handleDeleteUnlinked(recording);
		});
	}

	/**
	 * Scan the note folder for existing ad hoc meeting notes that can receive a
	 * recording: locally-created (no real calendar event), not merged away, and not
	 * already linked to a transcript. Sorted by proximity to the recording's start so
	 * the most likely match surfaces first; notes with no parseable time sort last.
	 * These are offered alongside calendar events in the link modal.
	 */
	private findUnlinkedAdhocNotes(
		recording: UnlinkedRecording,
		unlinkedProvider: UnlinkedRecordingProvider,
	): LinkableNote[] {
		const folder = this.app.vault.getAbstractFileByPath(this.settings.noteFolderPath);
		if (!(folder instanceof TFolder)) return [];

		const out: Array<LinkableNote & {sortKey: number}> = [];
		for (const child of getMarkdownFilesRecursive(folder)) {
			const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
			if (!fm) continue;

			// Skip transcript files and notes merged away into another card.
			const tags = Array.isArray(fm["tags"]) ? fm["tags"] as string[] : [];
			if (tags.includes("transcript")) continue;
			if (fm[FM.MERGED_INTO]) continue;

			// Ad hoc only: no real Graph event backing it. Calendar-backed notes are
			// already reachable through the event path above.
			const eventId = fm[FM.CALENDAR_EVENT_ID] as string | undefined;
			if (eventId && eventId !== "unscheduled") continue;

			// Must look like a meeting note (avoid listing arbitrary vault notes).
			const meetingSubject = fm["meeting_subject"] as string | undefined;
			if (!meetingSubject && !tags.includes("meeting")) continue;

			// Skip notes from a different calendar provider (mirrors findLocalNotes).
			const noteProvider = fm["calendar_provider"] as string | undefined;
			if (noteProvider && noteProvider !== this.settings.calendarProvider) continue;

			// Already has a recording linked — nothing to attach.
			if (unlinkedProvider.isNoteLinked(fm as Record<string, unknown>)) continue;

			const subject = child.basename.replace(/^\d{4}-\d{2}-\d{2}\s*-?\s*/, "")
				|| meetingSubject || child.basename;

			const meetingDate = coerceFmDate(fm["meeting_date"]);
			const meetingStart = coerceFmTime(fm["meeting_start"]);
			const date = (meetingDate && meetingStart)
				? parseDateTime(meetingDate, meetingStart)
				: null;
			const sortKey = date
				? Math.abs(date.getTime() - recording.recordingStart.getTime())
				: Number.MAX_SAFE_INTEGER;

			out.push({path: child.path, subject, date, sortKey});
		}

		out.sort((a, b) => a.sortKey - b.sortKey);
		return out.slice(0, 50).map(({path, subject, date}) => ({path, subject, date}));
	}

	private async handleLinkUnlinked(recording: UnlinkedRecording, card: HTMLElement): Promise<void> {
		try {
			// Try to find matching calendar events from cache
			const recordingDate = recording.recordingStart;
			const events = await this.provider.fetchEvents(recordingDate, this.settings.timezone);

			// Filter to timed events within the recording match window
			const windowMs = this.settings.recordingWindowMinutes * 60 * 1000;
			const candidates = events.filter(e => {
				if (e.isAllDay) return false;
				const diff = Math.abs(e.startTime.getTime() - recordingDate.getTime());
				return diff <= windowMs;
			});

			const unlinkedProvider = this.callbacks.getUnlinkedProvider();

			// Exclude events whose notes already have a recording linked
			const unlinkedCandidates = candidates.filter(e => {
				const noteFile = this.noteCreator.findNote(e);
				if (!noteFile) return true;
				const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
				return !unlinkedProvider.isNoteLinked(fm as Record<string, unknown> ?? {});
			});

			// Existing ad hoc notes (unscheduled, no transcript yet) are offered as
			// direct link targets so a recording can attach to a note the user already
			// created — not just a calendar event or a brand-new note.
			const adhocNotes = this.findUnlinkedAdhocNotes(recording, unlinkedProvider);

			const modal = new EventSuggestModal(
				this.app, unlinkedCandidates, this.settings.timezone, adhocNotes,
			);
			const choice = await modal.prompt();
			if (!choice) return; // user cancelled

			if (choice.type === "existing-note") {
				// Link to an existing ad hoc note — no note creation. linkToNote reads
				// this note's frontmatter for meeting context/invitees and writes the
				// transcript pointer back onto it, so pass the real on-disk path.
				const noteFile = this.app.vault.getAbstractFileByPath(choice.note.path);
				const noteFm = (noteFile instanceof TFile
					? this.app.metadataCache.getFileCache(noteFile)?.frontmatter
					: undefined) as Record<string, unknown> | undefined;
				await unlinkedProvider.linkToNote({
					app: this.app,
					recording,
					notePath: choice.note.path,
					subject: choice.note.subject,
					timezone: this.settings.timezone,
					transcriptFolderPath: this.settings.transcriptFolderPath,
					isRecurring: noteFm?.["is_recurring"] === true,
					meetingDate: typeof noteFm?.["meeting_date"] === "string" ? noteFm["meeting_date"] : undefined,
					meetingStart: typeof noteFm?.["meeting_start"] === "string" ? noteFm["meeting_start"] : undefined,
					meetingEnd: typeof noteFm?.["meeting_end"] === "string" ? noteFm["meeting_end"] : undefined,
					organizer: typeof noteFm?.["meeting_organizer"] === "string" ? noteFm["meeting_organizer"] : undefined,
					location: typeof noteFm?.["meeting_location"] === "string" ? noteFm["meeting_location"] : undefined,
				});
			} else if (choice.type === "event") {
				// Link to existing calendar event
				await this.noteCreator.createNote(choice.event);
				const notePath = this.noteCreator.getNotePath(choice.event);
				await unlinkedProvider.linkToNote({
					app: this.app,
					recording,
					notePath,
					subject: choice.event.subject,
					timezone: this.settings.timezone,
					transcriptFolderPath: this.settings.transcriptFolderPath,
					attendees: choice.event.attendees,
					isRecurring: choice.event.isRecurring,
					meetingDate: formatDate(choice.event.startTime, this.settings.timezone),
					meetingStart: formatTime(choice.event.startTime, this.settings.timezone),
					meetingEnd: formatTime(choice.event.endTime, this.settings.timezone),
					organizer: choice.event.organizerName,
					location: choice.event.location,
				});
			} else {
				// Create new meeting — prompt for a name. The recording's
				// title is shown verbatim, and the user's final name is used
				// verbatim as the note filename (bypassing the template's
				// "{{date}} - {{subject}}" prefix, which would otherwise
				// duplicate a date already present in the recording title).
				const defaultName = recording.title || this.settings.unscheduledSubject;
				const name = await new NameInputModal(this.app, {
					defaultValue: defaultName,
				}).prompt();
				if (!name) return;
				const subject = name;
				const event: CalendarEvent = {
					id: "unscheduled",
					subject,
					body: "",
					isAllDay: false,
					isOnlineMeeting: false,
					onlineMeetingUrl: "",
					startTime: recording.recordingStart,
					endTime: new Date(recording.recordingStart.getTime() + recording.durationSeconds * 1000),
					location: "",
					attendeeCount: 0,
					attendees: [],
					organizerName: "",
					organizerEmail: "",
					isOrganizer: false,
					isRecurring: false,
					seriesId: "",
					responseStatus: "organizer",
					categories: [],
				};
				await this.noteCreator.createNote(event, {preserveTimestamps: true, filenameOverride: name});
				const notePath = this.noteCreator.getNotePath(event, {filenameOverride: name});
				await unlinkedProvider.linkToNote({
					app: this.app,
					recording,
					notePath,
					subject,
					timezone: this.settings.timezone,
					transcriptFolderPath: this.settings.transcriptFolderPath,
				});

			}

			// Re-render timeline so the new/updated card appears.
			// findLocalNotes() will pick up the newly created note via vault scan.
			if (this.cachedEvents) {
				this.renderEvents(this.cachedEvents);
			}
			// Rebuild the unlinked section from truth (linkage now established)
			void this.loadAndRenderUnlinkedSection();
		} catch (e) {
			console.error("[WhisperCal] Link unlinked recording error:", e);
			new Notice(`Failed to link recording: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async handleDeleteUnlinked(recording: UnlinkedRecording): Promise<void> {
		const title = recording.title || "Untitled recording";
		const confirmed = await new DeleteTranscriptModal(this.app, title).prompt();
		if (!confirmed) return;

		try {
			if (recording.transcriptPath) {
				const file = this.app.vault.getAbstractFileByPath(recording.transcriptPath);
				if (file instanceof TFile) {
					await this.app.fileManager.trashFile(file);
				}
			}
			void this.loadAndRenderUnlinkedSection();
		} catch (e) {
			console.error("[WhisperCal] Delete unlinked transcript error:", e);
			new Notice(`Failed to delete transcript: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Keys from frontmatter that affect card rendering. */
	private static readonly FM_KEYS = [
		FM.MACWHISPER_SESSION_ID, FM.TRANSCRIPT, FM.PIPELINE_STATE, FM.CALENDAR_EVENT_ID,
		"research_notes", FM.RESEARCH_STATE, FM.MERGED_INTO,
	] as const;

	/** Build a stable string from card-relevant frontmatter values. */
	private getFmKey(path: string): string {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return "";
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return "";
		const base = CalendarView.FM_KEYS.map(k => `${k}=${fm[k] ?? ""}`).join("|");
		// Proposal presence isn't a flat fm key (it lives on the attendees
		// array) but drives the Speakers-pill candidates dot. Including it
		// here means the dot renders when the metadataCache catches up with
		// writeSpeakerProposals — the explicit refresh right after the write
		// can land before the cache reflects it.
		return `${base}|proposals=${hasCachedProposals(this.app, path)}`;
	}

	/** Snapshot frontmatter for all notes relevant to the current card set. */
	private snapshotFrontmatter(): void {
		this.fmSnapshot.clear();
		const folder = this.app.vault.getAbstractFileByPath(this.settings.noteFolderPath);
		if (folder instanceof TFolder) {
			for (const file of getMarkdownFilesRecursive(folder)) {
				this.fmSnapshot.set(file.path, this.getFmKey(file.path));
			}
		}
		const tFolder = this.app.vault.getAbstractFileByPath(this.settings.transcriptFolderPath);
		if (tFolder instanceof TFolder) {
			for (const file of getMarkdownFilesRecursive(tFolder)) {
				this.fmSnapshot.set(file.path, this.getFmKey(file.path));
			}
		}
	}

	private formatRecordingDate(date: Date): string {
		const now = new Date();
		const sameYear = date.getFullYear() === now.getFullYear();
		const dateOpts: Intl.DateTimeFormatOptions = {month: "short", day: "numeric"};
		if (!sameYear) dateOpts.year = "numeric";
		const datePart = date.toLocaleDateString(undefined, dateOpts);
		const timePart = date.toLocaleTimeString(undefined, {
			hour: "numeric", minute: "2-digit", timeZone: this.settings.timezone, hour12: getHour12(),
		});
		return `${datePart}, ${timePart}`;
	}


	private navigateDay(offset: number): void {
		this.selectedDate = new Date(
			this.selectedDate.getFullYear(),
			this.selectedDate.getMonth(),
			this.selectedDate.getDate() + offset,
		);
		this.lastRefreshTime = 0; // reset debounce
		this.updateHeader();
		void this.refresh();
	}

	private navigateToToday(): void {
		this.selectedDate = new Date();
		this.lastRefreshTime = 0;
		this.updateHeader();
		void this.refresh();
	}

	private updateHeader(): void {
		if (this.dateEl) {
			this.dateEl.textContent = formatDisplayDate(this.selectedDate, this.settings.timezone);
		}
		this.updateTodayButtonVisibility();
	}

	private updateTodayButtonVisibility(): void {
		if (!this.todayBtn) return;
		const isToday = isSameDay(this.selectedDate, new Date(), this.settings.timezone);
		this.todayBtn.toggleClass("whisper-cal-hidden", isToday);
	}

	private updateStatusIndicator(): void {
		if (!this.statusEl) return;
		const status = this.callbacks.getCacheStatus();
		if (!status) {
			this.statusEl.toggleClass("whisper-cal-hidden", true);
			return;
		}

		this.statusEl.empty();
		this.statusEl.toggleClass("whisper-cal-hidden", false);

		const dot = this.statusEl.createSpan({cls: "whisper-cal-status-dot"});
		const isConnected = status.connected && status.source === "live";
		dot.toggleClass("whisper-cal-status-connected", isConnected);
		dot.toggleClass("whisper-cal-status-disconnected", !isConnected);

		let text: string;
		if (isConnected && status.fetchedAt) {
			text = `Updated ${this.formatCacheAge(Date.now() - status.fetchedAt)}`;
		} else if (!isConnected && status.fetchedAt) {
			text = `Cached ${this.formatCacheAge(Date.now() - status.fetchedAt)}`;
		} else {
			text = "Offline";
		}
		this.statusEl.createSpan({cls: "whisper-cal-status-text", text});
	}

	private formatCacheAge(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return "just now";
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes} min ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	private startAutoRefresh(): void {
		this.stopAutoRefresh();
		const intervalMs = this.settings.refreshIntervalMinutes * 60 * 1000;
		this.refreshTimerId = window.setInterval(() => {
			void this.refresh();
		}, intervalMs);
		this.registerInterval(this.refreshTimerId);
	}

	private stopAutoRefresh(): void {
		if (this.refreshTimerId !== null) {
			window.clearInterval(this.refreshTimerId);
			this.refreshTimerId = null;
		}
	}

	/** Place the current-time marker: through the live meeting, or in the whitespace between. */
	private updateNowMarker(): void {
		if (!this.contentContainer) return;
		const content = this.contentContainer;
		content.querySelector(".whisper-cal-now-line")?.remove();
		content.querySelector(".whisper-cal-day-done")?.remove();
		if (!isSameDay(this.selectedDate, new Date(), this.settings.timezone)) return;

		const nowMs = Date.now();
		// Cards render in chronological (start-time) order — relied on below.
		const cards = Array.from(content.querySelectorAll<HTMLElement>(".whisper-cal-card[data-start-time]"));
		if (cards.length === 0) return;

		const cRect = content.getBoundingClientRect();
		const relTop = (el: HTMLElement): number =>
			el.getBoundingClientRect().top - cRect.top + content.scrollTop;
		const height = (el: HTMLElement): number => el.getBoundingClientRect().height;

		let topPx: number;
		// True only once "now" is past the day's last meeting — earns a friendly sign-off.
		let afterLast = false;

		// A meeting is live: slide the line down through its card as it elapses. When several
		// overlap, the one actually being captured wins — an active recording first, then a
		// card mid-pipeline (transcribing/tagging/summarizing), then a card whose capture
		// already happened (transcript linked — the meeting actually attended, even after
		// its pipeline finishes), then the most recently started one as the freshest
		// "current" meeting.
		const cardUi = this.callbacks.cardUi;
		const liveRank = (card: HTMLElement): number => {
			const notePath = card.dataset.notePath;
			if (!notePath) return 0;
			if (cardUi.hasRecording(notePath)) return 3;
			const variant = cardUi.getStatus(notePath)?.variant;
			if (variant === "recording" || variant === "progress") return 2;
			return card.dataset.pipelineTouched === "1" ? 1 : 0;
		};
		let live: HTMLElement | null = null;
		let liveStart = -Infinity;
		let liveRankBest = -1;
		for (const card of cards) {
			const start = Number(card.dataset.startTime);
			const end = Number(card.dataset.endTime);
			if (start > nowMs || nowMs >= end) continue;
			const rank = liveRank(card);
			if (rank > liveRankBest || (rank === liveRankBest && start > liveStart)) {
				live = card;
				liveStart = start;
				liveRankBest = rank;
			}
		}

		if (live) {
			const start = Number(live.dataset.startTime);
			const end = Number(live.dataset.endTime);
			const frac = end > start ? Math.min(0.92, Math.max(0.08, (nowMs - start) / (end - start))) : 0.08;
			topPx = relTop(live) + frac * height(live);
		} else {
			// Not in any meeting. Prefer the gap spacer that contains "now" so the dot lines
			// up with that gap's dotted rule + duration label; otherwise use the whitespace
			// midpoint between the surrounding cards.
			let gapPx: number | null = null;
			for (const g of Array.from(content.querySelectorAll<HTMLElement>(".whisper-cal-gap[data-gap-start]"))) {
				if (nowMs >= Number(g.dataset.gapStart) && nowMs < Number(g.dataset.gapEnd)) {
					gapPx = relTop(g) + height(g) / 2;
					break;
				}
			}
			if (gapPx !== null) {
				topPx = gapPx;
			} else {
				// The last card that has already started sits just above the current whitespace.
				let aboveIdx = -1;
				for (let i = 0; i < cards.length; i++) {
					if (Number(cards[i]!.dataset.startTime) <= nowMs) aboveIdx = i; else break;
				}
				if (aboveIdx === -1) return; // before the day's first meeting — no marker
				const above = cards[aboveIdx]!;
				const below = cards[aboveIdx + 1] ?? null;
				if (below) {
					// Truly between two meetings: float in the gap between them.
					topPx = (relTop(above) + height(above) + relTop(below)) / 2;
				} else {
					// After the day's last meeting — sit just below it.
					topPx = relTop(above) + height(above);
					afterLast = true;
				}
			}
		}

		// Day's meetings are behind us: render a thin "end of day" card (styled like the all-day
		// cards up top) at the bottom of the list, then center the "now" dot on it so the ball
		// sits inline with the message rather than floating in open whitespace.
		if (afterLast) {
			const doneCard = content.createDiv({
				cls: "whisper-cal-card whisper-cal-card-allday whisper-cal-day-done",
			});
			doneCard.createDiv({cls: "whisper-cal-allday-gutter whisper-cal-day-done-gutter"});
			const body = doneCard.createDiv({cls: "whisper-cal-allday-content"});
			const row = body.createDiv({cls: "whisper-cal-allday-row"});
			row.createSpan({
				cls: "whisper-cal-allday-subject whisper-cal-day-done-subject",
				text: "Nothing left on the calendar — you made it!",
			});
			topPx = relTop(doneCard) + height(doneCard) / 2;
		}

		const marker = content.createDiv({cls: "whisper-cal-now-line"});
		// Between/after meetings: show just the dot so the line doesn't cross the gap's
		// duration label. The full line is reserved for a meeting that's actually live.
		if (!live) marker.addClass("whisper-cal-now-line--dot");
		marker.setCssProps({"--wc-now-top": `${topPx}px`});
	}

	private static readonly NOW_MARKER_INTERVAL_MS = 60_000;

	private startNowLineTimer(): void {
		this.stopNowLineTimer();
		this.updateNowMarker();
		this.nowLineTimerId = window.setInterval(() => {
			this.updateNowMarker();
		}, CalendarView.NOW_MARKER_INTERVAL_MS);
		this.registerInterval(this.nowLineTimerId);
	}

	private stopNowLineTimer(): void {
		if (this.nowLineTimerId !== null) {
			window.clearInterval(this.nowLineTimerId);
			this.nowLineTimerId = null;
		}
	}

}
