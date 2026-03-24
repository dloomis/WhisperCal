export interface EventAttendee {
	name: string;
	email: string;
}

export type ResponseStatus = "accepted" | "tentativelyAccepted" | "declined" | "notResponded" | "organizer" | "none";

export interface EventCategory {
	name: string;
	color: string;
}

export interface CalendarEvent {
	id: string;
	subject: string;
	body: string;
	isAllDay: boolean;
	isOnlineMeeting: boolean;
	onlineMeetingUrl: string;
	startTime: Date;
	endTime: Date;
	location: string;
	attendeeCount: number;
	attendees: EventAttendee[];
	organizerName: string;
	organizerEmail: string;
	isOrganizer: boolean;
	isRecurring: boolean;
	responseStatus: ResponseStatus;
	categories: EventCategory[];
}

export type CalendarProviderType = "microsoft" | "google";

export interface CalendarProvider {
	fetchEvents(date: Date, timezone: string): Promise<CalendarEvent[]>;
	isAvailable(): Promise<boolean>;
	getUserEmail(): string;
}
