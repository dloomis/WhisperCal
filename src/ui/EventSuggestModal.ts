import {App, SuggestModal} from "obsidian";
import type {CalendarEvent} from "../types";
import {formatTime} from "../utils/time";

/**
 * An existing meeting note (typically ad hoc / unscheduled) that has no transcript
 * linked yet. Offered as a link target so a recording can attach to a note the user
 * already created, rather than only to a calendar event or a brand-new note.
 */
export interface LinkableNote {
	/** Vault path to the note file. */
	path: string;
	/** Display subject (basename with the date prefix stripped, or meeting_subject). */
	subject: string;
	/** Meeting start, for display and proximity sorting; null when unknown. */
	date: Date | null;
}

type EventChoice =
	| {type: "event"; event: CalendarEvent}
	| {type: "existing-note"; note: LinkableNote}
	| {type: "new-meeting"};

export class EventSuggestModal extends SuggestModal<EventChoice> {
	private choices: EventChoice[];
	private timezone: string;
	private resolve: ((value: EventChoice | null) => void) | null = null;
	private selected: EventChoice | null = null;

	constructor(app: App, events: CalendarEvent[], timezone: string, existingNotes: LinkableNote[] = []) {
		super(app);
		this.choices = [
			...events.map(event => ({type: "event" as const, event})),
			...existingNotes.map(note => ({type: "existing-note" as const, note})),
			{type: "new-meeting" as const},
		];
		this.timezone = timezone;
		this.setPlaceholder("Link to a calendar event or ad hoc note, or create new meeting");
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
			if (c.type === "existing-note") return c.note.subject.toLowerCase().includes(q);
			return c.event.subject.toLowerCase().includes(q);
		});
	}

	renderSuggestion(choice: EventChoice, el: HTMLElement): void {
		if (choice.type === "new-meeting") {
			el.createDiv({text: "Create new meeting"});
			el.createDiv({cls: "suggestion-note", text: "No calendar event"});
			return;
		}
		if (choice.type === "existing-note") {
			el.createDiv({text: choice.note.subject});
			const when = choice.note.date
				? choice.note.date.toLocaleDateString(undefined, {
					month: "short", day: "numeric", timeZone: this.timezone,
				})
				: null;
			const parts = ["Ad hoc note"];
			if (when) parts.push(when);
			el.createDiv({cls: "suggestion-note", text: parts.join(" · ")});
			return;
		}
		const event = choice.event;
		el.createDiv({text: event.subject});
		const date = event.startTime.toLocaleDateString(undefined, {
			month: "short", day: "numeric", timeZone: this.timezone,
		});
		const time = event.isAllDay
			? "All day"
			: `${formatTime(event.startTime, this.timezone)} – ${formatTime(event.endTime, this.timezone)}`;
		const parts = [date, time];
		if (event.attendeeCount > 0) parts.push(`${event.attendeeCount} attendees`);
		if (event.location) parts.push(event.location);
		el.createDiv({cls: "suggestion-note", text: parts.join(" · ")});
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
