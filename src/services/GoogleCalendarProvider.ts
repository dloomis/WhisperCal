import {requestUrl} from "obsidian";
import type {CalendarEvent, CalendarProvider, EventCategory} from "../types";
import {getDayStartUTC, getDayEndUTC} from "../utils/time";
import type {GoogleAuth} from "./GoogleAuth";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/** Google Calendar event color IDs → hex values */
const EVENT_COLORS: Record<string, string> = {
	"1":  "#7986cb", // Lavender
	"2":  "#33b679", // Sage
	"3":  "#8e24aa", // Grape
	"4":  "#e67c73", // Flamingo
	"5":  "#f6bf26", // Banana
	"6":  "#f4511e", // Tangerine
	"7":  "#039be5", // Peacock
	"8":  "#616161", // Graphite
	"9":  "#3f51b5", // Blueberry
	"10": "#0b8043", // Basil
	"11": "#d50000", // Tomato
};

// Google Calendar API response shapes
interface GoogleDateTime {
	dateTime?: string;
	date?: string;
	timeZone?: string;
}

interface GoogleAttendee {
	email?: string;
	displayName?: string;
	self?: boolean;
	responseStatus?: string;
}

interface GoogleOrganizer {
	email?: string;
	displayName?: string;
	self?: boolean;
}

interface GoogleConferenceEntryPoint {
	entryPointType?: string;
	uri?: string;
}

interface GoogleConferenceData {
	entryPoints?: GoogleConferenceEntryPoint[];
}

interface GoogleCalendarEvent {
	id: string;
	summary?: string;
	description?: string;
	start: GoogleDateTime;
	end: GoogleDateTime;
	location?: string;
	attendees?: GoogleAttendee[];
	organizer?: GoogleOrganizer;
	recurringEventId?: string;
	hangoutLink?: string;
	conferenceData?: GoogleConferenceData;
	colorId?: string;
	status?: string;
}

interface GoogleEventsResponse {
	items?: GoogleCalendarEvent[];
	nextPageToken?: string;
}

export class GoogleCalendarProvider implements CalendarProvider {
	private auth: GoogleAuth;
	private userEmail: string | null = null;

	constructor(auth: GoogleAuth) {
		this.auth = auth;
	}

	async isAvailable(): Promise<boolean> {
		return this.auth.isSignedIn();
	}

	async fetchEvents(date: Date, timezone: string): Promise<CalendarEvent[]> {
		const token = await this.auth.getAccessToken();

		if (this.userEmail === null) {
			await this.fetchUserEmail(token);
		}

		const timeMin = getDayStartUTC(date, timezone);
		const timeMax = getDayEndUTC(date, timezone);

		const params = new URLSearchParams({
			timeMin,
			timeMax,
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: "250",
		});

		const allEvents: GoogleCalendarEvent[] = [];
		let pageToken: string | null = null;

		do {
			if (pageToken) params.set("pageToken", pageToken);
			const response = await requestUrl({
				url: `${CALENDAR_BASE}/calendars/primary/events?${params.toString()}`,
				method: "GET",
				headers: {Authorization: `Bearer ${token}`},
			});
			const data = response.json as GoogleEventsResponse;
			const items = data.items ?? [];
			// Filter out cancelled events
			allEvents.push(...items.filter(e => e.status !== "cancelled"));
			pageToken = data.nextPageToken ?? null;
		} while (pageToken);

		const email = this.userEmail ?? "";
		return allEvents.map(e => parseGoogleEvent(e, email));
	}

	getUserEmail(): string {
		return this.userEmail ?? "";
	}

	private async fetchUserEmail(token: string): Promise<void> {
		try {
			const response = await requestUrl({
				url: USERINFO_URL,
				method: "GET",
				headers: {Authorization: `Bearer ${token}`},
			});
			const data = response.json as {email?: string};
			this.userEmail = (data.email ?? "").toLowerCase();
		} catch (e) {
			console.debug("[WhisperCal] Failed to fetch Google user email:", e);
			this.userEmail = "";
		}
	}
}

function parseGoogleEvent(event: GoogleCalendarEvent, userEmail: string): CalendarEvent {
	const attendees = (event.attendees ?? []).map(a => ({
		name: a.displayName ?? "",
		email: a.email ?? "",
	}));

	const isAllDay = !!event.start.date && !event.start.dateTime;

	// Parse start/end — all-day events use date, timed events use dateTime
	const startTime = isAllDay
		? new Date(event.start.date + "T00:00:00")
		: new Date(event.start.dateTime!);
	const endTime = isAllDay
		? new Date(event.end.date + "T00:00:00")
		: new Date(event.end.dateTime!);

	// Find self in attendees for response status
	const selfAttendee = (event.attendees ?? []).find(a => a.self);
	const responseStatus = mapResponseStatus(selfAttendee?.responseStatus);

	// Online meeting URL — prefer conferenceData video entry, fall back to hangoutLink
	let onlineMeetingUrl = "";
	const videoEntry = event.conferenceData?.entryPoints?.find(
		ep => ep.entryPointType === "video",
	);
	if (videoEntry?.uri) {
		onlineMeetingUrl = videoEntry.uri;
	} else if (event.hangoutLink) {
		onlineMeetingUrl = event.hangoutLink;
	}

	// Categories from colorId
	const categories: EventCategory[] = [];
	if (event.colorId && EVENT_COLORS[event.colorId]) {
		categories.push({name: event.colorId, color: EVENT_COLORS[event.colorId]!});
	}

	return {
		id: event.id,
		subject: event.summary ?? "(No title)",
		body: event.description ?? "",
		isAllDay,
		isOnlineMeeting: !!onlineMeetingUrl,
		onlineMeetingUrl,
		startTime,
		endTime,
		location: event.location ?? "",
		attendeeCount: attendees.length,
		attendees,
		organizerName: event.organizer?.displayName ?? "",
		organizerEmail: event.organizer?.email ?? "",
		isOrganizer: event.organizer?.self ?? (userEmail !== "" && (event.organizer?.email ?? "").toLowerCase() === userEmail),
		isRecurring: !!event.recurringEventId,
		responseStatus,
		categories,
	};
}

function mapResponseStatus(status?: string): CalendarEvent["responseStatus"] {
	switch (status) {
	case "accepted": return "accepted";
	case "declined": return "declined";
	case "tentative": return "tentativelyAccepted";
	case "needsAction": return "notResponded";
	default: return "none";
	}
}
