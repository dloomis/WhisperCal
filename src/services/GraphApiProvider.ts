import {requestUrl} from "obsidian";
import type {CalendarEvent, CalendarProvider, GraphEvent} from "../types";
import {getDayStartUTC, getDayEndUTC} from "../utils/time";
import type {MsalAuth} from "./MsalAuth";

export class GraphApiProvider implements CalendarProvider {
	private auth: MsalAuth;

	constructor(auth: MsalAuth) {
		this.auth = auth;
	}

	async isAvailable(): Promise<boolean> {
		return this.auth.isSignedIn();
	}

	async fetchEvents(date: Date, timezone: string): Promise<CalendarEvent[]> {
		const token = await this.auth.getAccessToken();
		const startDateTime = getDayStartUTC(date, timezone);
		const endDateTime = getDayEndUTC(date, timezone);

		const graphBase = this.auth.getGraphBaseUrl();
		const url = `${graphBase}/v1.0/me/calendarView?startDateTime=${startDateTime}&endDateTime=${endDateTime}&$orderby=start/dateTime&$select=id,subject,start,end,location,isAllDay,attendees,organizer,isOnlineMeeting,type`;

		const response = await requestUrl({
			url,
			method: "GET",
			headers: {Authorization: `Bearer ${token}`},
		});

		const data = response.json as { value?: GraphEvent[] } | GraphEvent[];
		const events = Array.isArray(data) ? data : (data.value ?? []);
		return events.map(parseGraphEvent);
	}
}

function parseGraphEvent(event: GraphEvent): CalendarEvent {
	const attendees = event.attendees?.map(a => a.emailAddress.name) ?? [];
	return {
		id: event.id,
		subject: event.subject ?? "(No subject)",
		isAllDay: event.isAllDay ?? false,
		isOnlineMeeting: event.isOnlineMeeting ?? false,
		startTime: new Date(event.start.dateTime + "Z"),
		endTime: new Date(event.end.dateTime + "Z"),
		location: event.location?.displayName ?? "",
		attendeeCount: attendees.length,
		attendees,
		organizerName: event.organizer?.emailAddress?.name ?? "",
		organizerEmail: event.organizer?.emailAddress?.address ?? "",
	};
}
