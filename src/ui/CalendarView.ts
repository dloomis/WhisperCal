import {ItemView, WorkspaceLeaf} from "obsidian";
import {VIEW_TYPE_CALENDAR} from "../constants";
import type {CalendarEvent, CalendarProvider} from "../types";
import type {WhisperCalSettings} from "../settings";
import {NoteCreator} from "./NoteCreator";
import {renderMeetingCard} from "./MeetingCard";
import {formatDisplayDate, getTodayString} from "../utils/time";
import {M365CliError} from "../services/M365CliProvider";

export class CalendarView extends ItemView {
	private settings: WhisperCalSettings;
	private provider: CalendarProvider;
	private noteCreator: NoteCreator;
	private contentContainer: HTMLElement | null = null;
	private currentDateString: string;
	private refreshTimerId: number | null = null;
	private lastRefreshTime = 0;
	private static readonly DEBOUNCE_MS = 2000;

	constructor(
		leaf: WorkspaceLeaf,
		settings: WhisperCalSettings,
		provider: CalendarProvider,
	) {
		super(leaf);
		this.settings = settings;
		this.provider = provider;
		this.noteCreator = new NoteCreator(this.app, settings);
		this.currentDateString = getTodayString(settings.timezone);
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
		header.createEl("h3", {
			cls: "whisper-cal-date",
			text: formatDisplayDate(new Date(), this.settings.timezone),
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
		this.stopAutoRefresh();
	}

	async refresh(): Promise<void> {
		const now = Date.now();
		if (now - this.lastRefreshTime < CalendarView.DEBOUNCE_MS) {
			return;
		}
		this.lastRefreshTime = now;

		if (!this.contentContainer) return;

		// Check for midnight rollover
		const todayString = getTodayString(this.settings.timezone);
		if (todayString !== this.currentDateString) {
			this.currentDateString = todayString;
			// Update the header date
			const header = this.containerEl.querySelector(".whisper-cal-date");
			if (header) {
				header.textContent = formatDisplayDate(new Date(), this.settings.timezone);
			}
		}

		this.renderLoading();

		try {
			const available = await this.provider.isAvailable();
			if (!available) {
				this.renderError("Not signed in. Run `m365 login` in your terminal first.");
				return;
			}

			const events = await this.provider.fetchEvents(new Date());
			this.renderEvents(events);
		} catch (e) {
			if (e instanceof M365CliError) {
				this.renderError(e.message);
			} else {
				this.renderError("Failed to fetch calendar events.");
			}
		}
	}

	updateSettings(settings: WhisperCalSettings, provider: CalendarProvider): void {
		this.settings = settings;
		this.provider = provider;
		this.noteCreator = new NoteCreator(this.app, settings);
		this.restartAutoRefresh();
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
		this.contentContainer.empty();

		if (events.length === 0) {
			this.contentContainer.createDiv({
				cls: "whisper-cal-empty",
				text: "No meetings today",
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
				renderMeetingCard(this.contentContainer, event, this.settings.timezone, this.noteCreator);
			}
		}

		if (timed.length > 0) {
			this.contentContainer.createDiv({
				cls: "whisper-cal-section-title",
				text: "Today",
			});
			for (const event of timed) {
				renderMeetingCard(this.contentContainer, event, this.settings.timezone, this.noteCreator);
			}
		}
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
