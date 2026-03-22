import {htmlToMarkdown, requestUrl} from "obsidian";
import type {CalendarEvent, CalendarProvider, GraphEvent} from "../types";
import {getDayStartUTC, getDayEndUTC} from "../utils/time";
import type {MsalAuth} from "./MsalAuth";

export class GraphApiProvider implements CalendarProvider {
	private auth: MsalAuth;
	private userEmail: string | null = null;

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

		// Fetch user email on first call for organizer detection
		if (this.userEmail === null) {
			await this.fetchUserEmail(token);
		}

		const graphBase = this.auth.getGraphBaseUrl();
		const baseUrl = `${graphBase}/v1.0/me/calendarView?startDateTime=${startDateTime}&endDateTime=${endDateTime}&$orderby=start/dateTime&$top=50&$select=id,subject,body,start,end,location,isAllDay,attendees,organizer,isOnlineMeeting,onlineMeetingUrl,onlineMeeting,type,responseStatus`;

		const allEvents: GraphEvent[] = [];
		let url: string | null = baseUrl;

		while (url) {
			const response = await requestUrl({
				url,
				method: "GET",
				headers: {Authorization: `Bearer ${token}`},
			});

			const data = response.json as { value?: GraphEvent[]; "@odata.nextLink"?: string } | GraphEvent[];
			if (Array.isArray(data)) {
				allEvents.push(...data);
				url = null;
			} else {
				allEvents.push(...(data.value ?? []));
				url = data["@odata.nextLink"] ?? null;
			}
		}

		const userEmail = this.userEmail ?? "";
		return allEvents.map(e => parseGraphEvent(e, userEmail));
	}

	getUserEmail(): string {
		return this.userEmail ?? "";
	}

	private async fetchUserEmail(token: string): Promise<void> {
		try {
			const graphBase = this.auth.getGraphBaseUrl();
			const response = await requestUrl({
				url: `${graphBase}/v1.0/me?$select=mail,userPrincipalName`,
				method: "GET",
				headers: {Authorization: `Bearer ${token}`},
			});
			const data = response.json as { mail?: string; userPrincipalName?: string };
			this.userEmail = (data.mail ?? data.userPrincipalName ?? "").toLowerCase();
		} catch (e) {
			console.debug("[WhisperCal] Failed to fetch user email:", e);
			this.userEmail = "";
		}
	}
}

function parseGraphEvent(event: GraphEvent, userEmail: string): CalendarEvent {
	const attendees = event.attendees?.map(a => ({
		name: a.emailAddress.name ?? "",
		email: a.emailAddress.address ?? "",
	})) ?? [];
	const rawBody = event.body?.content ?? "";
	const body = event.body?.contentType === "text"
		? rawBody.trim()
		: htmlToMarkdown(rawBody).trim();

	return {
		id: event.id,
		subject: event.subject ?? "(No subject)",
		body,
		isAllDay: event.isAllDay ?? false,
		isOnlineMeeting: event.isOnlineMeeting ?? false,
		onlineMeetingUrl: event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? "",
		startTime: new Date(event.start.dateTime + "Z"),
		endTime: new Date(event.end.dateTime + "Z"),
		location: event.location?.displayName ?? "",
		attendeeCount: attendees.length,
		attendees,
		organizerName: event.organizer?.emailAddress?.name ?? "",
		organizerEmail: event.organizer?.emailAddress?.address ?? "",
		isOrganizer: userEmail !== "" && (event.organizer?.emailAddress?.address ?? "").toLowerCase() === userEmail,
		isRecurring: event.type !== "singleInstance",
		responseStatus: (event.responseStatus?.response as CalendarEvent["responseStatus"]) ?? "none",
	};
}
