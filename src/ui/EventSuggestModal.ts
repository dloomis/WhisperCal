import {App, SuggestModal} from "obsidian";
import type {CalendarEvent} from "../types";
import {formatTime} from "../utils/time";

type EventChoice =
	| {type: "event"; event: CalendarEvent}
	| {type: "new-meeting"};

export class EventSuggestModal extends SuggestModal<EventChoice> {
	private choices: EventChoice[];
	private timezone: string;
	private resolve: ((value: EventChoice | null) => void) | null = null;
	private selected: EventChoice | null = null;

	constructor(app: App, events: CalendarEvent[], timezone: string) {
		super(app);
		this.choices = [
			...events.map(event => ({type: "event" as const, event})),
			{type: "new-meeting" as const},
		];
		this.timezone = timezone;
		this.setPlaceholder("Link to calendar event or create new meeting");
	}

	prompt(): Promise<EventChoice | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	getSuggestions(query: string): EventChoice[] {
		const q = query.toLowerCase();
		if (!q) return this.choices;
		return this.choices.filter(c => {
			if (c.type === "new-meeting") return true;
			return c.event.subject.toLowerCase().includes(q);
		});
	}

	renderSuggestion(choice: EventChoice, el: HTMLElement): void {
		if (choice.type === "new-meeting") {
			el.createDiv({text: "Create new meeting"});
			el.createDiv({cls: "suggestion-note", text: "No calendar event"});
			return;
		}
		const event = choice.event;
		el.createDiv({text: event.subject});
		const date = event.startTime.toLocaleDateString(undefined, {
			month: "short", day: "numeric", timeZone: this.timezone,
		});
		const time = event.isAllDay
			? "All day"
			: `${formatTime(event.startTime, this.timezone)} \u2013 ${formatTime(event.endTime, this.timezone)}`;
		const parts = [date, time];
		if (event.attendeeCount > 0) parts.push(`${event.attendeeCount} attendees`);
		if (event.location) parts.push(event.location);
		el.createDiv({cls: "suggestion-note", text: parts.join(" \u00B7 ")});
	}

	onChooseSuggestion(choice: EventChoice): void {
		this.selected = choice;
	}

	onClose(): void {
		super.onClose();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(this.selected);
				this.resolve = null;
			}
		}, 0);
	}
}
