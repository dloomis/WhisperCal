export interface EventAttendee {
	name: string;
	email: string;
}

export type ResponseStatus = "accepted" | "tentativelyAccepted" | "declined" | "notResponded" | "organizer" | "none";

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
}

export interface CalendarProvider {
	fetchEvents(date: Date, timezone: string): Promise<CalendarEvent[]>;
	isAvailable(): Promise<boolean>;
}

// Graph API response shapes from m365 CLI (JSON output)
export interface GraphDateTimeZone {
	dateTime: string;
	timeZone: string;
}

export interface GraphEmailAddress {
	name: string;
	address: string;
}

export interface GraphAttendee {
	emailAddress: GraphEmailAddress;
}

export interface GraphLocation {
	displayName: string;
}

export interface GraphBody {
	contentType: string;
	content: string;
}

export interface GraphOnlineMeeting {
	joinUrl: string;
}

export interface GraphResponseStatus {
	response: string;
	time: string;
}

export interface GraphEvent {
	id: string;
	subject: string;
	body: GraphBody;
	isAllDay: boolean;
	isOnlineMeeting: boolean;
	onlineMeetingUrl: string | null;
	onlineMeeting: GraphOnlineMeeting | null;
	start: GraphDateTimeZone;
	end: GraphDateTimeZone;
	location: GraphLocation;
	attendees: GraphAttendee[];
	organizer: {
		emailAddress: GraphEmailAddress;
	};
	type: string;
	responseStatus: GraphResponseStatus;
}
