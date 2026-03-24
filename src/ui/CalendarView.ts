import {ItemView, TFile, TFolder, WorkspaceLeaf, setIcon} from "obsidian";
import {getLinkedSessionIds, getMarkdownFilesRecursive} from "../utils/vault";
import {VIEW_TYPE_CALENDAR} from "../constants";
import type {CalendarEvent, CalendarProvider} from "../types";
import type {WhisperCalSettings} from "../settings";
import type {CacheStatus} from "../services/CalendarCache";
import {findRecentSessions, type MacWhisperRecording} from "../services/MacWhisperDb";
import {linkKnownRecording} from "../services/LinkRecording";
import {EventSuggestModal} from "./EventSuggestModal";
import {NameInputModal} from "./NameInputModal";
import {NoteCreator} from "./NoteCreator";
import {renderMeetingCard, type MeetingCardOpts} from "./MeetingCard";
import {formatDate, formatDisplayDate, formatRecordingDuration, formatTime, getTodayString, isSameDay, parseDateTime} from "../utils/time";
import {AuthError} from "../services/CalendarAuth";

/** Coerce a YAML frontmatter time value to "HH:MM" or "H:MM AM/PM" string.
 *  YAML parses unquoted "16:39" as sexagesimal number 999. */
function coerceFmTime(val: unknown): string | undefined {
	if (val == null) return undefined;
	if (typeof val === "number") {
		const h = Math.floor(val / 60);
		const m = val % 60;
		return `${h}:${String(m).padStart(2, "0")}`;
	}
	return String(val);
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
	return String(val);
}

export interface CalendarViewCallbacks {
	getCacheStatus: () => CacheStatus | null;
	getUserEmail: () => string;
	onTagSpeakers: (transcriptFile: TFile, transcriptFm: Record<string, unknown>) => void;
	onSummarize: (notePath: string) => void;
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
	private cardElements = new Map<string, HTMLElement>();
	private cardOpts = new Map<string, MeetingCardOpts>();
	private pendingFmPaths = new Set<string>();

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

		const prevBtn = nav.createDiv({cls: "whisper-cal-nav-btn clickable-icon", attr: {"aria-label": "Previous day"}});
		setIcon(prevBtn, "chevron-left");
		this.registerDomEvent(prevBtn, "click", () => this.navigateDay(-1));

		this.dateEl = nav.createDiv({
			cls: "whisper-cal-date",
			text: formatDisplayDate(this.selectedDate, this.settings.timezone),
		});

		const nextBtn = nav.createDiv({cls: "whisper-cal-nav-btn clickable-icon", attr: {"aria-label": "Next day"}});
		setIcon(nextBtn, "chevron-right");
		this.registerDomEvent(nextBtn, "click", () => this.navigateDay(1));

		// Today button (hidden when already viewing today)
		this.todayBtn = header.createDiv({cls: "whisper-cal-today-btn", text: "Today"});
		this.registerDomEvent(this.todayBtn, "click", () => this.navigateToToday());
		this.updateTodayButtonVisibility();

		// Refresh action button in view header
		this.addAction("refresh-cw", "Refresh calendar", () => {
			void this.refresh();
		});

		// Cache status indicator
		this.statusEl = stickyHeader.createDiv({cls: "whisper-cal-status whisper-cal-hidden"});

		// Content area
		this.contentContainer = root.createDiv({cls: "whisper-cal-content"});
		this.unlinkedEl = root.createDiv({cls: "whisper-cal-unlinked-section"});

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
					this.updateCardsForPaths(paths);
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
		this.noteOpenPath = null;
		this.unlinkedEl = null;
		this.cardElements.clear();
		this.cardOpts.clear();
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

		this.renderLoading();

		try {
			const events = await this.provider.fetchEvents(this.selectedDate, this.settings.timezone);
			if (events.length === 0) {
				// Check if we're truly disconnected with no cache
				const status = this.callbacks.getCacheStatus();
				if (status && !status.connected && status.fetchedAt === null) {
					this.renderError("Not signed in. Open settings to sign in to your calendar account.");
					this.updateStatusIndicator();
					this.updateTodayButtonVisibility();
					void this.loadAndRenderUnlinkedSection();
					return;
				}
			}
			this.renderEvents(events);
			this.updateNowMarker();
		} catch (e) {
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
		this.startAutoRefresh();
		this.lastRefreshTime = 0;
		void this.refresh();
	}

	rerenderCards(): void {
		if (this.cachedEvents === null) return;
		for (const eventId of this.cardElements.keys()) {
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
		this.cardElements.clear();
		this.cardOpts.clear();

		const isToday = isSameDay(this.selectedDate, new Date(), this.settings.timezone);

		const onNoteCreated = (eventId: string) => {
			this.rerenderCardById(eventId);
		};
		const importantEmails = this.settings.importantOrganizers.map(o => o.email);

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
		const unscheduledOpts: MeetingCardOpts = {
			event: unscheduledEvent,
			timezone: this.settings.timezone,
			noteCreator: this.noteCreator,
			app: this.app,
			transcriptFolderPath: this.settings.transcriptFolderPath,
			recordingWindowMinutes: this.settings.recordingWindowMinutes,
			importantOrganizerEmails: importantEmails,
			llmEnabled: this.settings.llmEnabled,
			onNoteCreated,
			onTagSpeakers: this.callbacks.onTagSpeakers,
			onSummarize: this.callbacks.onSummarize,
		};
		this.storeCard(unscheduledEvent.id, renderMeetingCard(this.contentContainer, unscheduledOpts), unscheduledOpts);

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
				const opts: MeetingCardOpts = {
					event,
					timezone: this.settings.timezone,
					noteCreator: this.noteCreator,
					app: this.app,
					transcriptFolderPath: this.settings.transcriptFolderPath,
					recordingWindowMinutes: this.settings.recordingWindowMinutes,
					importantOrganizerEmails: importantEmails,
					onNoteCreated,
					onTagSpeakers: this.callbacks.onTagSpeakers,
					onSummarize: this.callbacks.onSummarize,
				};
				this.storeCard(event.id, renderMeetingCard(this.contentContainer, opts), opts);
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
					if (gapMs >= 60_000) {
						const gapMin = Math.round(gapMs / 60_000);
						let gapText: string;
						if (gapMin >= 60) {
							const h = Math.floor(gapMin / 60);
							const m = gapMin % 60;
							gapText = m > 0 ? `${h}h ${m}m` : `${h}h`;
						} else {
							gapText = `${gapMin}m`;
						}
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
					const opts: MeetingCardOpts = {
						event,
						timezone: this.settings.timezone,
						noteCreator: this.noteCreator,
						app: this.app,
						transcriptFolderPath: this.settings.transcriptFolderPath,
						recordingWindowMinutes: this.settings.recordingWindowMinutes,
						importantOrganizerEmails: importantEmails,
						onNoteCreated,
						onTagSpeakers: this.callbacks.onTagSpeakers,
						onSummarize: this.callbacks.onSummarize,
					};
					this.storeCard(event.id, renderMeetingCard(target, opts), opts);
				}
			}
		}

		// Reset so updateNoteOpenHighlight re-applies to the new DOM
		this.noteOpenPath = null;
		this.applyNoteOpenHighlight();

		// Snapshot frontmatter so the changed handler can detect real changes
		this.snapshotFrontmatter();
	}

	private storeCard(eventId: string, el: HTMLElement, opts: MeetingCardOpts): void {
		this.cardElements.set(eventId, el);
		this.cardOpts.set(eventId, opts);
	}

	/** Rebuild a single card in-place without touching any other DOM. */
	private rerenderCardById(eventId: string): void {
		const oldEl = this.cardElements.get(eventId);
		const opts = this.cardOpts.get(eventId);
		if (!oldEl || !opts) return;

		// Build replacement off-DOM
		const tmp = document.createElement("div");
		const newEl = renderMeetingCard(tmp, opts);

		// Preserve highlight class
		if (oldEl.hasClass("whisper-cal-card-note-open")) {
			newEl.addClass("whisper-cal-card-note-open");
		}

		oldEl.replaceWith(newEl);
		this.cardElements.set(eventId, newEl);
	}

	/** Re-render only the cards affected by a set of changed file paths. */
	private updateCardsForPaths(paths: Set<string>): void {
		for (const [eventId, el] of this.cardElements) {
			if ((el.dataset.notePath && paths.has(el.dataset.notePath))
				|| (el.dataset.transcriptPath && paths.has(el.dataset.transcriptPath))) {
				this.rerenderCardById(eventId);
			}
		}
	}

	/** Find the card whose note or transcript matches a file path, and re-render it. */
	private rerenderCardByPath(filePath: string): void {
		for (const [eventId, el] of this.cardElements) {
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

			// Only show local notes that are already linked to a MacWhisper recording
			if (!fm["macwhisper_session_id"]) continue;

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

		const sessions = await findRecentSessions(
			this.settings.unlinkedLookbackDays,
		);

		// Bail if a newer call superseded us
		if (gen !== this.unlinkedGeneration) return;

		const linked = this.getLinkedSessionIds();
		const unlinked = sessions.filter(s => !linked.has(s.sessionId));

		if (unlinked.length === 0) {
			this.unlinkedEl.createDiv({
				cls: "whisper-cal-unlinked-empty",
				text: `No unlinked MacWhisper recordings for the last ${this.settings.unlinkedLookbackDays} days`,
			});
			return;
		}

		// Collapsible header
		const header = this.unlinkedEl.createDiv({cls: "whisper-cal-unlinked-header"});
		const arrow = header.createSpan({cls: "whisper-cal-unlinked-arrow", text: this.unlinkedCollapsed ? "\u25B8" : "\u25BE"});
		header.createSpan({text: `Unlinked recordings (${unlinked.length})`});

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

	private getLinkedSessionIds(): Set<string> {
		return getLinkedSessionIds(this.app);
	}

	private renderUnlinkedCard(container: HTMLElement, recording: MacWhisperRecording): void {
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
	}

	private async handleLinkUnlinked(recording: MacWhisperRecording, card: HTMLElement): Promise<void> {
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

		// Exclude events whose notes already have a recording linked
		const unlinkedCandidates = candidates.filter(e => {
			const noteFile = this.noteCreator.findNote(e);
			if (!noteFile) return true;
			const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
			return !fm?.["macwhisper_session_id"];
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
			await linkKnownRecording({
				app: this.app,
				session: recording,
				notePath,
				subject: choice.event.subject,
				timezone: this.settings.timezone,
				transcriptFolderPath: this.settings.transcriptFolderPath,
				attendees: choice.event.attendees,
				isRecurring: choice.event.isRecurring,
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
			await linkKnownRecording({
				app: this.app,
				session: recording,
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
		// Rebuild the unlinked section from truth (frontmatter now has session ID)
		void this.loadAndRenderUnlinkedSection();
	}

	/** Keys from frontmatter that affect card rendering. */
	private static readonly FM_KEYS = [
		"macwhisper_session_id", "transcript", "pipeline_state", "calendar_event_id",
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
		const datePart = date.toLocaleDateString("en-US", dateOpts);
		const timePart = date.toLocaleTimeString("en-US", {
			hour: "numeric", minute: "2-digit", timeZone: this.settings.timezone,
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
				if (nowMs >= Number(cards[i]!.dataset.startTime)) {
					target = (cards[i]!.closest(".whisper-cal-conflict-group") as HTMLElement | null) ?? cards[i]!;
					break;
				}
			}
		}
		if (!target) return; // before all meetings — no marker

		// Place marker at vertical center of target
		const cRect = this.contentContainer.getBoundingClientRect();
		const tRect = target.getBoundingClientRect();
		const marker = createDiv({cls: "whisper-cal-now-line"});
		marker.style.position = "absolute";
		marker.style.top = `${tRect.top - cRect.top + this.contentContainer.scrollTop + tRect.height / 2}px`;
		this.contentContainer.appendChild(marker);
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
