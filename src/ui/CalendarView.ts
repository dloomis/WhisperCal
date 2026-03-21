import {ItemView, TFile, TFolder, WorkspaceLeaf, setIcon} from "obsidian";
import {getMarkdownFilesRecursive} from "../utils/vault";
import {VIEW_TYPE_CALENDAR} from "../constants";
import type {CalendarEvent, CalendarProvider} from "../types";
import type {WhisperCalSettings} from "../settings";
import type {CacheStatus} from "../services/CalendarCache";
import {findRecentSessions, type MacWhisperRecording} from "../services/MacWhisperDb";
import {linkKnownRecording} from "../services/LinkRecording";
import {EventSuggestModal} from "./EventSuggestModal";
import {NameInputModal} from "./NameInputModal";
import {NoteCreator} from "./NoteCreator";
import {renderMeetingCard} from "./MeetingCard";
import {formatDate, formatDisplayDate, formatRecordingDuration, getTodayString, isSameDay, parseDateTime} from "../utils/time";
import {AuthError} from "../services/MsalAuth";

export class CalendarView extends ItemView {
	private settings: WhisperCalSettings;
	private provider: CalendarProvider;
	private noteCreator: NoteCreator;
	private contentContainer: HTMLElement | null = null;
	private currentDateString: string;
	private refreshTimerId: number | null = null;
	private lastRefreshTime = 0;
	private static readonly DEBOUNCE_MS = 2000;
	private selectedDate: Date;
	private cachedEvents: CalendarEvent[] | null = null;
	private cardRefreshTimer: number | null = null;
	private dateEl: HTMLElement | null = null;
	private todayBtn: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private getCacheStatus: (() => CacheStatus | null) | null = null;
	private onTagSpeakers: ((transcriptFile: TFile, transcriptFm: Record<string, unknown>) => void) | null = null;
	private onSummarize: ((notePath: string) => void) | null = null;
	private noteOpenPath: string | null = null;
	private stickyHeaderEl: HTMLElement | null = null;
	private unlinkedEl: HTMLElement | null = null;
	private unlinkedCollapsed = true;
	private unlinkedGeneration = 0;
	constructor(
		leaf: WorkspaceLeaf,
		settings: WhisperCalSettings,
		provider: CalendarProvider,
		getCacheStatus?: () => CacheStatus | null,
		onTagSpeakers?: (transcriptFile: TFile, transcriptFm: Record<string, unknown>) => void,
		onSummarize?: (notePath: string) => void,
	) {
		super(leaf);
		this.settings = settings;
		this.provider = provider;
		this.noteCreator = new NoteCreator(this.app, settings);
		this.currentDateString = getTodayString(settings.timezone);
		this.selectedDate = new Date();
		this.getCacheStatus = getCacheStatus ?? null;
		this.onTagSpeakers = onTagSpeakers ?? null;
		this.onSummarize = onSummarize ?? null;
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
		this.contentContainer = root.createDiv();
		this.unlinkedEl = root.createDiv({cls: "whisper-cal-unlinked-section"});

		// Initial load
		await this.refresh();

		// Re-render cards when a meeting note's frontmatter changes
		// (e.g. macwhisper_session_id added via title bar mic or command)
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (this.cachedEvents === null) return;
				if (!file.path.startsWith(this.settings.noteFolderPath + "/")) return;
				if (this.cardRefreshTimer !== null) {
					window.clearTimeout(this.cardRefreshTimer);
				}
				this.cardRefreshTimer = window.setTimeout(() => {
					this.cardRefreshTimer = null;
					this.renderEvents(this.cachedEvents!);
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
	}

	async onClose(): Promise<void> {
		this.stopAutoRefresh();
		this.noteOpenPath = null;
		this.unlinkedEl = null;
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
				const status = this.getCacheStatus?.();
				if (status && !status.connected && status.fetchedAt === null) {
					this.renderError("Not signed in. Open settings to sign in to your Microsoft account.");
					this.updateStatusIndicator();
					this.updateTodayButtonVisibility();
					void this.loadAndRenderUnlinkedSection();
					return;
				}
			}
			this.renderEvents(events);
		} catch (e) {
			console.error("[WhisperCal] refresh error:", e);
			if (e instanceof AuthError) {
				this.renderError(e.message);
			} else {
				this.renderError("Failed to fetch calendar events.");
			}
		}

		this.updateStatusIndicator();
		this.updateTodayButtonVisibility();
		void this.loadAndRenderUnlinkedSection();
	}

	updateSettings(
		settings: WhisperCalSettings,
		provider: CalendarProvider,
		getCacheStatus?: () => CacheStatus | null,
		onTagSpeakers?: (transcriptFile: TFile, transcriptFm: Record<string, unknown>) => void,
		onSummarize?: (notePath: string) => void,
	): void {
		this.settings = settings;
		this.provider = provider;
		if (getCacheStatus) {
			this.getCacheStatus = getCacheStatus;
		}
		if (onTagSpeakers) {
			this.onTagSpeakers = onTagSpeakers;
		}
		if (onSummarize) {
			this.onSummarize = onSummarize;
		}
		this.noteCreator = new NoteCreator(this.app, settings);
		this.restartAutoRefresh();
		this.lastRefreshTime = 0;
		void this.refresh();
	}

	rerenderCards(): void {
		if (this.cachedEvents !== null) {
			// Preserve scroll position across pill-state rerenders
			const scrollTop = this.contentEl.scrollTop;
			this.renderEvents(this.cachedEvents);
			this.contentEl.scrollTop = scrollTop;
		}
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
		this.cachedEvents = events;
		this.contentContainer.empty();

		const isToday = isSameDay(this.selectedDate, new Date(), this.settings.timezone);
		const activeEventIds = isToday ? this.findActiveEventIds(events) : new Set<string>();

		const onNoteCreated = () => {
			this.lastRefreshTime = 0;
			void this.refresh();
		};

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
			isRecurring: false,
		};
		renderMeetingCard(this.contentContainer, {
			event: unscheduledEvent,
			timezone: this.settings.timezone,
			noteCreator: this.noteCreator,
			app: this.app,
			isActive: false,
			transcriptFolderPath: this.settings.transcriptFolderPath,
			recordingWindowMinutes: this.settings.recordingWindowMinutes,
			onNoteCreated,
			onTagSpeakers: this.onTagSpeakers ?? undefined,
			onSummarize: this.onSummarize ?? undefined,
		});

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

		const allDay = merged.filter(e => e.isAllDay);
		const timed = merged.filter(e => !e.isAllDay);
		timed.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

		if (allDay.length > 0) {
			this.contentContainer.createDiv({
				cls: "whisper-cal-section-title",
				text: "All day",
			});
			for (const event of allDay) {
				renderMeetingCard(this.contentContainer, {
					event,
					timezone: this.settings.timezone,
					noteCreator: this.noteCreator,
					app: this.app,
					isActive: activeEventIds.has(event.id),
					transcriptFolderPath: this.settings.transcriptFolderPath,
					recordingWindowMinutes: this.settings.recordingWindowMinutes,
					onNoteCreated,
					onTagSpeakers: this.onTagSpeakers ?? undefined,
					onSummarize: this.onSummarize ?? undefined,
				});
			}
		}

		if (timed.length > 0) {
			this.contentContainer.createDiv({
				cls: "whisper-cal-section-title",
				text: isToday ? "Today" : "Scheduled",
			});
			for (const event of timed) {
				renderMeetingCard(this.contentContainer, {
					event,
					timezone: this.settings.timezone,
					noteCreator: this.noteCreator,
					app: this.app,
					isActive: activeEventIds.has(event.id),
					transcriptFolderPath: this.settings.transcriptFolderPath,
					recordingWindowMinutes: this.settings.recordingWindowMinutes,
					onNoteCreated,
					onTagSpeakers: this.onTagSpeakers ?? undefined,
					onSummarize: this.onSummarize ?? undefined,
				});
			}
		}

		// Reset so updateNoteOpenHighlight re-applies to the new DOM
		this.noteOpenPath = null;
		this.applyNoteOpenHighlight();
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

			// Only show local notes that are already linked to a MacWhisper recording
			if (!fm["macwhisper_session_id"]) continue;

			// Parse meeting_start from frontmatter (e.g. "9:30 AM")
			const meetingStart = fm["meeting_start"] as string | undefined;
			const meetingDate = fm["meeting_date"] as string | undefined;
			const meetingSubject = fm["meeting_subject"] as string | undefined;

			const meetingEnd = fm["meeting_end"] as string | undefined;

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
				isRecurring: false,
			});
		}
		return results;
	}

	private updateNoteOpenHighlight(): void {
		if (!this.contentContainer) return;
		const activePath = this.app.workspace.getActiveFile()?.path ?? null;
		if (activePath === this.noteOpenPath) return;

		const cls = "whisper-cal-card-note-open";

		// Remove from previous
		if (this.noteOpenPath !== null) {
			const prev = this.contentContainer.querySelector(
				`[data-note-path="${CSS.escape(this.noteOpenPath)}"]`,
			);
			prev?.removeClass(cls);
		}

		// Add to current
		if (activePath !== null) {
			const curr = this.contentContainer.querySelector(
				`[data-note-path="${CSS.escape(activePath)}"]`,
			);
			if (curr instanceof HTMLElement) {
				curr.addClass(cls);
			}
		}

		this.noteOpenPath = activePath;
	}

	/** Apply highlight to freshly-built DOM (no early-return guard). */
	private applyNoteOpenHighlight(): void {
		if (!this.contentContainer) return;
		const activePath = this.app.workspace.getActiveFile()?.path ?? null;
		const cls = "whisper-cal-card-note-open";

		if (activePath !== null) {
			const curr = this.contentContainer.querySelector(
				`[data-note-path="${CSS.escape(activePath)}"]`,
			);
			if (curr instanceof HTMLElement) {
				curr.addClass(cls);
			}
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
		const linked = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const sid = fm?.["macwhisper_session_id"] as string | undefined;
			if (sid) linked.add(sid);
		}
		return linked;
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
				isRecurring: false,
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
		}

		// Rebuild the unlinked section from truth (frontmatter now has session ID)
		void this.loadAndRenderUnlinkedSection();
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

	private findActiveEventIds(events: CalendarEvent[]): Set<string> {
		const now = new Date();
		const timed = events.filter(e => !e.isAllDay);

		// Highlight all ongoing meetings (startTime <= now < endTime)
		const ongoing = timed.filter(e => e.startTime <= now && e.endTime > now);
		if (ongoing.length > 0) {
			return new Set(ongoing.map(e => e.id));
		}

		// Otherwise highlight just the next upcoming meeting
		const upcoming = timed.filter(e => e.startTime > now);
		if (upcoming.length > 0) {
			upcoming.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
			return new Set([upcoming[0]!.id]);
		}

		return new Set();
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
		const status = this.getCacheStatus?.();
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

	private restartAutoRefresh(): void {
		this.startAutoRefresh();
	}
}
