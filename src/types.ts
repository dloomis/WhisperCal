export interface EventAttendee {
	name: string;
	email: string;
}

export interface CalendarEvent {
	id: string;
	subject: string;
	isAllDay: boolean;
	isOnlineMeeting: boolean;
	startTime: Date;
	endTime: Date;
	location: string;
	attendeeCount: number;
	attendees: EventAttendee[];
	organizerName: string;
	organizerEmail: string;
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

export interface GraphEvent {
	id: string;
	subject: string;
	isAllDay: boolean;
	isOnlineMeeting: boolean;
	start: GraphDateTimeZone;
	end: GraphDateTimeZone;
	location: GraphLocation;
	attendees: GraphAttendee[];
	organizer: {
		emailAddress: GraphEmailAddress;
	};
	type: string;
}
