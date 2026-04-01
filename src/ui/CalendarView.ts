import {ItemView, Notice, TFile, TFolder, WorkspaceLeaf, setIcon} from "obsidian";
import {getMarkdownFilesRecursive} from "../utils/vault";
import {VIEW_TYPE_CALENDAR} from "../constants";
import type {CalendarEvent, CalendarProvider} from "../types";
import type {WhisperCalSettings} from "../settings";
import type {CacheStatus} from "../services/CalendarCache";
import type {UnlinkedRecording, UnlinkedRecordingProvider} from "../services/UnlinkedRecordingProvider";
import {EventSuggestModal} from "./EventSuggestModal";
import {NameInputModal} from "./NameInputModal";
import {NoteCreator} from "./NoteCreator";
import {renderAllDayCard, renderMeetingCard, updateMeetingCard, type MeetingCardOpts} from "./MeetingCard";
import {formatDate, formatDisplayDate, formatRecordingDuration, formatTime, getHour12, getTodayString, isSameDay, parseDateTime} from "../utils/time";
import {AuthError} from "../services/CalendarAuth";
import type {AuthState} from "../services/AuthTypes";
import {autoCreatePeopleNotes} from "../services/PeopleAutoCreate";
import {PeopleMatchService} from "../services/PeopleMatchService";
import {resolveRecordingApiBaseUrl} from "../services/RecordingApi";

/** Coerce a YAML frontmatter time value to "HH:MM" or "H:MM AM/PM" string.
 *  YAML parses unquoted "16:39" as sexagesimal number 999. */
function coerceFmTime(val: unknown): string | undefined {
	if (val == null) return undefined;
	if (typeof val === "number") {
		const h = Math.floor(val / 60);
		const m = val % 60;
		return `${h}:${String(m).padStart(2, "0")}`;
	}
	if (typeof val === "string") return val;
	// YAML may produce unexpected types — coerce to string as last resort
	return `${val as string}`;
}

/** Coerce a YAML frontmatter date value to "YYYY-MM-DD" string.
 *  YAML may parse unquoted dates as Date objects. */
function coerceFmDate(val: unknown): string | undefined {
	if (val == null) return undefined;
	if (val instanceof Date) {
		const y = val.getFullYear();
		const m = String(val.getMonth() + 1).padStart(2, "0");
		const d = String(val.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
	if (typeof val === "string") return val;
	return `${val as string}`;
}

export interface CalendarViewCallbacks {
	getCacheStatus: () => CacheStatus | null;
	getUserEmail: () => string;
	onTagSpeakers: (transcriptFile: TFile, transcriptFm: Record<string, unknown>, notePath: string) => void;
	onSummarize: (notePath: string) => void;
	onResearch: (notePath: string) => void;
	getAuthState: () => AuthState;
	onSignIn: () => Promise<void>;
	onOpenSettings: () => void;
	subscribeAuthState: (listener: (state: AuthState) => void) => () => void;
	getUnlinkedProvider: () => UnlinkedRecordingProvider;
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
	private nowLineTimerId: number | null = null;
	private cards = new Map<string, {el: HTMLElement; opts: MeetingCardOpts}>();
	private pendingFmPaths = new Set<string>();
	private refreshGeneration = 0;
	private peopleMatchService: PeopleMatchService | null = null;
	private unsubscribeAuth: (() => void) | null = null;
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
		this.authStatusEl = null;
		this.noteOpenPath = null;
		this.unlinkedEl = null;
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
			this.updateNowMarker();

			// Auto-create People notes for unmatched organizers (fire-and-forget)
			if (this.settings.peopleFolderPath) {
				void autoCreatePeopleNotes(
					this.app,
					this.settings.peopleFolderPath,
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
	}

	rerenderCard(notePath: string): void {
		this.rerenderCardByPath(notePath);
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
			if (state.userCode && state.verificationUri) {
				// Microsoft Device Code Flow — show code + link
				this.authStatusEl.createDiv({
					cls: "whisper-cal-auth-label",
					text: "Enter this code in your browser:",
				});
				const codeEl = this.authStatusEl.createDiv({cls: "whisper-cal-device-code"});
				codeEl.setText(state.userCode);
				const linkEl = this.authStatusEl.createEl("a", {
					cls: "whisper-cal-auth-link",
					text: state.verificationUri,
					href: state.verificationUri,
				});
				linkEl.setAttr("target", "_blank");
				linkEl.setAttr("rel", "noopener");
			} else {
				// Google loopback flow
				this.authStatusEl.createDiv({
					cls: "whisper-cal-auth-label",
					text: state.message ?? "Signing in\u2026",
				});
			}
			this.authStatusEl.createDiv({
				cls: "whisper-cal-auth-hint",
				text: "Waiting for authorization\u2026",
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
			responseStatus: "organizer",
			categories: [],
		};
		this.renderAndStoreCard(this.contentContainer, unscheduledEvent);
		this.contentContainer.createDiv({cls: "whisper-cal-adhoc-divider"});

		if (events.length === 0) {
			this.contentContainer.createDiv({
				cls: "whisper-cal-empty",
				text: isToday ? "No meetings today" : "No meetings",
			});
			return;
		}

		// Merge notes not backed by a Graph API event into the timeline
		// (covers "unscheduled", "macwhisper-*", and any other local-only notes)
		const calendarEventIds = new Set(events.map(e => e.id));
		const localNotes = this.findLocalNotes(calendarEventIds);
		const merged = [...events, ...localNotes];

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
			transcriptFolderPath: this.settings.transcriptFolderPath,
			recordingWindowMinutes: this.settings.recordingWindowMinutes,
			importantOrganizerEmails: this.settings.importantOrganizers.map(o => o.email),
			llmEnabled: this.settings.llmEnabled,
			recordingApiBaseUrl: this.settings.recordingSource === "api"
				? resolveRecordingApiBaseUrl(this.settings.recordingApiBaseUrl) || undefined
				: undefined,
			peopleMatchService: this.getOrCreatePeopleMatchService(),
			onNoteCreated: (eventId: string) => this.rerenderCardById(eventId),
			onTagSpeakers: this.callbacks.onTagSpeakers,
			onSummarize: this.callbacks.onSummarize,
			onResearch: this.callbacks.onResearch,
			speakerTagModel: this.settings.speakerTagModel,
			summarizerModel: this.settings.summarizerModel,
			researchModel: this.settings.researchModel,
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
		for (const [eventId, {el}] of this.cards) {
			if ((el.dataset.notePath && paths.has(el.dataset.notePath))
				|| (el.dataset.transcriptPath && paths.has(el.dataset.transcriptPath))) {
				this.rerenderCardById(eventId);
			}
		}
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
	 * and any other locally-created meeting notes.
	 */
	private findLocalNotes(calendarEventIds: Set<string>): CalendarEvent[] {
		const datePrefix = formatDate(this.selectedDate, this.settings.timezone);
		const folder = this.app.vault.getAbstractFileByPath(this.settings.noteFolderPath);
		if (!(folder instanceof TFolder)) return [];

		const files = getMarkdownFilesRecursive(folder);
		const results: CalendarEvent[] = [];
		for (const child of files) {
			if (!child.basename.startsWith(datePrefix)) continue;

			const cache = this.app.metadataCache.getFileCache(child);
			const fm = cache?.frontmatter;
			if (!fm) continue;

			const eventId = fm["calendar_event_id"] as string | undefined;
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

			// Prefer basename over frontmatter subject (user may rename the note)
			const displaySubject = child.basename.startsWith(`${datePrefix} - `)
				? child.basename.slice(datePrefix.length + 3)
				: meetingSubject ?? child.basename;

			results.push({
				id: `unscheduled-${child.path}`,
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
				responseStatus: "organizer",
				categories: [],
			});
		}
		return results;
	}

	/** Find card whose note or transcript matches the given path. */
	private findCardByPath(path: string): HTMLElement | null {
		if (!this.contentContainer) return null;
		const escaped = CSS.escape(path);
		const el = this.contentContainer.querySelector(
			`[data-note-path="${escaped}"], [data-transcript-path="${escaped}"]`,
		);
		return el instanceof HTMLElement ? el : null;
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

		if (unlinked.length === 0) {
			this.unlinkedEl.createDiv({
				cls: "whisper-cal-unlinked-empty",
				text: `No unlinked transcripts for the last ${this.settings.unlinkedLookbackDays} days`,
			});
			return;
		}

		// Collapsible header
		const header = this.unlinkedEl.createDiv({cls: "whisper-cal-unlinked-header"});
		const arrow = header.createSpan({cls: "whisper-cal-unlinked-arrow", text: this.unlinkedCollapsed ? "\u25B8" : "\u25BE"});
		header.createSpan({text: `Unlinked transcripts (${unlinked.length})`});

		const body = this.unlinkedEl.createDiv({cls: "whisper-cal-unlinked-body"});
		body.toggleClass("whisper-cal-hidden", this.unlinkedCollapsed);

		header.addEventListener("click", () => {
			this.unlinkedCollapsed = !this.unlinkedCollapsed;
			arrow.textContent = this.unlinkedCollapsed ? "\u25B8" : "\u25BE";
			body.toggleClass("whisper-cal-hidden", this.unlinkedCollapsed);
		});

		for (const recording of unlinked) {
			this.renderUnlinkedCard(body, recording);
		}
	}

	private renderUnlinkedCard(container: HTMLElement, recording: UnlinkedRecording): void {
		const card = container.createDiv({cls: "whisper-cal-unlinked-card"});

		const title = recording.title || "Untitled recording";
		card.createDiv({cls: "whisper-cal-unlinked-title", text: title});

		const meta = card.createDiv({cls: "whisper-cal-unlinked-meta"});
		const dateStr = this.formatRecordingDate(recording.recordingStart);
		const durStr = formatRecordingDuration(recording.durationSeconds);
		const parts = [dateStr];
		if (durStr) parts.push(durStr);
		if (recording.speakerCount > 0) parts.push(`${recording.speakerCount} speaker${recording.speakerCount === 1 ? "" : "s"}`);
		meta.createSpan({text: parts.join(" \u00B7 ")});

		const linkBtn = meta.createEl("button", {cls: "whisper-cal-btn whisper-cal-btn-small", text: "Link"});
		linkBtn.addEventListener("click", () => {
			linkBtn.disabled = true;
			void this.handleLinkUnlinked(recording, card).finally(() => {
				linkBtn.disabled = false;
			});
		});

		if (recording.transcriptPath) {
			const viewBtn = meta.createEl("button", {cls: "whisper-cal-btn whisper-cal-btn-small", text: "View"});
			viewBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.app.workspace.openLinkText(recording.transcriptPath!, "", false);
			});
		}
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

			const modal = new EventSuggestModal(
				this.app, unlinkedCandidates, this.settings.timezone,
			);
			const choice = await modal.prompt();
			if (!choice) return; // user cancelled

			if (choice.type === "event") {
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
				// Create new meeting — prompt for a name
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
					responseStatus: "organizer",
					categories: [],
				};
				await this.noteCreator.createNote(event, {preserveTimestamps: true});
				const notePath = this.noteCreator.getNotePath(event);
				await unlinkedProvider.linkToNote({
					app: this.app,
					recording,
					notePath,
					subject,
					timezone: this.settings.timezone,
					transcriptFolderPath: this.settings.transcriptFolderPath,
				});

				// Inject into timeline immediately (metadata cache may lag)
				if (this.cachedEvents) {
					this.cachedEvents.push({...event, id: `unscheduled-${notePath}`});
				}
			}

			// Re-render timeline so the new/updated card appears
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

	/** Keys from frontmatter that affect card rendering. */
	private static readonly FM_KEYS = [
		"macwhisper_session_id", "transcript", "pipeline_state", "calendar_event_id", "research_notes",
	] as const;

	/** Build a stable string from card-relevant frontmatter values. */
	private getFmKey(path: string): string {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return "";
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return "";
		return CalendarView.FM_KEYS.map(k => `${k}=${fm[k] ?? ""}`).join("|");
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

	/** Place the current-time marker centered on the active card or gap. */
	private updateNowMarker(): void {
		if (!this.contentContainer) return;
		this.contentContainer.querySelector(".whisper-cal-now-line")?.remove();
		if (!isSameDay(this.selectedDate, new Date(), this.settings.timezone)) return;

		const nowMs = Date.now();
		const cards = this.contentContainer.querySelectorAll<HTMLElement>(".whisper-cal-card[data-start-time]");
		if (cards.length === 0) return;

		// Find target: gap spacer containing now, or most-recent started card/group
		let target: HTMLElement | null = null;
		for (const g of Array.from(this.contentContainer.querySelectorAll<HTMLElement>(".whisper-cal-gap[data-gap-start]"))) {
			if (nowMs >= Number(g.dataset.gapStart) && nowMs < Number(g.dataset.gapEnd)) { target = g; break; }
		}
		if (!target) {
			for (let i = cards.length - 1; i >= 0; i--) {
				const card = cards[i]!;
				if (nowMs >= Number(card.dataset.startTime)) {
					const group = card.closest<HTMLElement>(".whisper-cal-conflict-group");
					target = group ?? card;
					break;
				}
			}
		}
		if (!target) return; // before all meetings — no marker

		// Place marker at vertical center of target
		const cRect = this.contentContainer.getBoundingClientRect();
		const tRect = target.getBoundingClientRect();
		const topPx = `${tRect.top - cRect.top + this.contentContainer.scrollTop + tRect.height / 2}px`;
		const marker = this.contentContainer.createDiv({cls: "whisper-cal-now-line"});
		marker.setCssProps({"--wc-now-top": topPx});
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
