import {ItemView, WorkspaceLeaf, setIcon} from "obsidian";
import {VIEW_TYPE_CALENDAR} from "../constants";
import type {CalendarEvent, CalendarProvider} from "../types";
import type {WhisperCalSettings} from "../settings";
import type {RecordingManager} from "../services/RecordingManager";
import {NoteCreator} from "./NoteCreator";
import {renderMeetingCard} from "./MeetingCard";
import {UnscheduledNoteModal} from "./UnscheduledNoteModal";
import {formatDate, formatDisplayDate, getTodayString, isSameDay} from "../utils/time";
import type {RecordingControlsHandle} from "./RecordingControls";
import {renderRecordingControls} from "./RecordingControls";
import {AuthError} from "../services/MsalAuth";

export class CalendarView extends ItemView {
	private settings: WhisperCalSettings;
	private provider: CalendarProvider;
	private recordingManager: RecordingManager;
	private noteCreator: NoteCreator;
	private contentContainer: HTMLElement | null = null;
	private currentDateString: string;
	private refreshTimerId: number | null = null;
	private lastRefreshTime = 0;
	private static readonly DEBOUNCE_MS = 2000;
	private selectedDate: Date;
	private dateEl: HTMLElement | null = null;
	private todayBtn: HTMLElement | null = null;
	private cardCleanups: Array<() => void> = [];
	private headerRecordingHandle: RecordingControlsHandle | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		settings: WhisperCalSettings,
		provider: CalendarProvider,
		recordingManager: RecordingManager,
	) {
		super(leaf);
		this.settings = settings;
		this.provider = provider;
		this.recordingManager = recordingManager;
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
		const container = this.containerEl.children[1];
		if (!container) return;
		container.empty();

		const root = container.createDiv({cls: "whisper-cal-container"});

		// Header
		const header = root.createDiv({cls: "whisper-cal-header"});

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

		// Header actions
		const actions = header.createDiv({cls: "whisper-cal-header-actions"});
		const createNoteBtn = actions.createEl("button", {
			cls: "whisper-cal-btn whisper-cal-btn-secondary",
			text: "Create note",
		});
		this.registerDomEvent(createNoteBtn, "click", () => {
			void this.createUnscheduledNote();
		});

		// Header recording controls (for unscheduled recordings)
		this.headerRecordingHandle = renderRecordingControls(actions, this.recordingManager, {
			eventId: "unscheduled",
			subject: "Recording",
			date: formatDate(this.selectedDate, this.settings.timezone),
		});

		// Refresh action button in view header
		this.addAction("refresh-cw", "Refresh calendar", () => {
			void this.refresh();
		});

		// Content area
		this.contentContainer = root.createDiv();

		// Initial load
		await this.refresh();

		// Start auto-refresh
		this.startAutoRefresh();
	}

	async onClose(): Promise<void> {
		this.headerRecordingHandle?.destroy();
		this.headerRecordingHandle = null;
		this.destroyCards();
		this.stopAutoRefresh();
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
		console.debug("[WhisperCal] refresh — selectedDate:", this.selectedDate.toISOString());

		try {
			const available = await this.provider.isAvailable();
			console.debug("[WhisperCal] isAvailable:", available);
			if (!available) {
				this.renderError("Not signed in. Open settings to sign in to your Microsoft account.");
				return;
			}

			const events = await this.provider.fetchEvents(this.selectedDate, this.settings.timezone);
			console.debug("[WhisperCal] fetchEvents returned", events.length, "events");
			this.renderEvents(events);
		} catch (e) {
			console.error("[WhisperCal] refresh error:", e);
			if (e instanceof AuthError) {
				this.renderError(e.message);
			} else {
				this.renderError("Failed to fetch calendar events.");
			}
		}

		this.updateTodayButtonVisibility();
	}

	updateSettings(
		settings: WhisperCalSettings,
		provider: CalendarProvider,
		recordingManager: RecordingManager,
	): void {
		this.settings = settings;
		this.provider = provider;
		this.recordingManager = recordingManager;
		this.noteCreator = new NoteCreator(this.app, settings);
		this.restartAutoRefresh();
	}

	private destroyCards(): void {
		for (const cleanup of this.cardCleanups) {
			cleanup();
		}
		this.cardCleanups = [];
	}

	private renderLoading(): void {
		if (!this.contentContainer) return;
		this.destroyCards();
		this.contentContainer.empty();
		this.contentContainer.createDiv({
			cls: "whisper-cal-loading",
			text: "Loading calendar...",
		});
	}

	private renderError(message: string): void {
		if (!this.contentContainer) return;
		this.destroyCards();
		this.contentContainer.empty();
		this.contentContainer.createDiv({
			cls: "whisper-cal-error",
			text: message,
		});
	}

	private renderEvents(events: CalendarEvent[]): void {
		if (!this.contentContainer) return;
		this.destroyCards();
		this.contentContainer.empty();

		const isToday = isSameDay(this.selectedDate, new Date(), this.settings.timezone);
		const activeEventId = isToday ? this.findActiveEventId(events) : null;

		if (events.length === 0) {
			this.contentContainer.createDiv({
				cls: "whisper-cal-empty",
				text: isToday ? "No meetings today" : "No meetings",
			});
			return;
		}

		const allDay = events.filter(e => e.isAllDay);
		const timed = events.filter(e => !e.isAllDay);

		if (allDay.length > 0) {
			this.contentContainer.createDiv({
				cls: "whisper-cal-section-title",
				text: "All day",
			});
			for (const event of allDay) {
				const handle = renderMeetingCard(
					this.contentContainer, event, this.settings.timezone,
					this.noteCreator, this.recordingManager,
					event.id === activeEventId,
				);
				this.cardCleanups.push(handle.destroy);
			}
		}

		if (timed.length > 0) {
			this.contentContainer.createDiv({
				cls: "whisper-cal-section-title",
				text: isToday ? "Today" : "Scheduled",
			});
			for (const event of timed) {
				const handle = renderMeetingCard(
					this.contentContainer, event, this.settings.timezone,
					this.noteCreator, this.recordingManager,
					event.id === activeEventId,
				);
				this.cardCleanups.push(handle.destroy);
			}
		}
	}

	private findActiveEventId(events: CalendarEvent[]): string | null {
		const now = new Date();
		const timed = events.filter(e => !e.isAllDay);

		// Prefer an ongoing meeting (startTime <= now < endTime)
		const ongoing = timed.filter(e => e.startTime <= now && e.endTime > now);
		if (ongoing.length > 0) {
			// If multiple overlap, pick the one that started most recently
			ongoing.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
			return ongoing[0]!.id;
		}

		// Otherwise highlight the next upcoming meeting
		const upcoming = timed.filter(e => e.startTime > now);
		if (upcoming.length > 0) {
			upcoming.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
			return upcoming[0]!.id;
		}

		return null;
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

	private async createUnscheduledNote(): Promise<void> {
		const modal = new UnscheduledNoteModal(this.app);
		const subject = await modal.prompt();
		if (!subject) return;

		const now = new Date(
			this.selectedDate.getFullYear(),
			this.selectedDate.getMonth(),
			this.selectedDate.getDate(),
			new Date().getHours(),
			new Date().getMinutes(),
		);

		const event: CalendarEvent = {
			id: `unscheduled-${Date.now()}`,
			subject,
			body: "",
			isAllDay: false,
			isOnlineMeeting: false,
			startTime: now,
			endTime: now,
			location: "",
			attendeeCount: 0,
			attendees: [],
			organizerName: "",
			organizerEmail: "",
		};

		await this.noteCreator.createNote(event);
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

	startAutoRefresh(): void {
		this.stopAutoRefresh();
		const intervalMs = this.settings.refreshIntervalMinutes * 60 * 1000;
		this.refreshTimerId = this.registerInterval(
			window.setInterval(() => {
				void this.refresh();
			}, intervalMs)
		) as unknown as number;
	}

	private stopAutoRefresh(): void {
		// registerInterval handles cleanup on unload; this is for manual restarts
		this.refreshTimerId = null;
	}

	private restartAutoRefresh(): void {
		this.startAutoRefresh();
	}
}
