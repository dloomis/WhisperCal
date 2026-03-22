import {htmlToMarkdown, requestUrl} from "obsidian";
import type {CalendarEvent, CalendarProvider, EventCategory, GraphEvent} from "../types";
import {getDayStartUTC, getDayEndUTC} from "../utils/time";
import type {MsalAuth} from "./MsalAuth";

/** Outlook preset color names → CSS hex values */
const PRESET_COLORS: Record<string, string> = {
	preset0:  "#e74856", // Red
	preset1:  "#ff8c00", // Orange
	preset2:  "#b4714a", // Brown/Peach
	preset3:  "#f5c400", // Yellow
	preset4:  "#3ba535", // Green
	preset5:  "#00aba9", // Teal
	preset6:  "#7a9a0a", // Olive
	preset7:  "#0078d7", // Blue
	preset8:  "#8764b8", // Purple
	preset9:  "#b5485d", // Cranberry
	preset10: "#617d8b", // Steel
	preset11: "#4a5459", // Dark Steel
	preset12: "#9e9d9d", // Gray
	preset13: "#636362", // Dark Gray
	preset14: "#3b3a39", // Black
	preset15: "#a4262c", // Dark Red
	preset16: "#c45100", // Dark Orange
	preset17: "#7a4e28", // Dark Brown
	preset18: "#c19c00", // Dark Yellow
	preset19: "#0a7729", // Dark Green
	preset20: "#037070", // Dark Teal
	preset21: "#54600c", // Dark Olive
	preset22: "#004e8c", // Dark Blue
	preset23: "#5c2d91", // Dark Purple
	preset24: "#7e3040", // Dark Cranberry
};

interface MasterCategory {
	displayName: string;
	color: string;
}

export class GraphApiProvider implements CalendarProvider {
	private auth: MsalAuth;
	private userEmail: string | null = null;
	private categoryColors: Map<string, string> | null = null;

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

		// Fetch user email + category colors on first call
		if (this.userEmail === null) {
			await this.fetchUserEmail(token);
		}
		if (this.categoryColors === null) {
			await this.fetchMasterCategories(token);
		}

		const graphBase = this.auth.getGraphBaseUrl();
		const baseUrl = `${graphBase}/v1.0/me/calendarView?startDateTime=${startDateTime}&endDateTime=${endDateTime}&$orderby=start/dateTime&$top=50&$select=id,subject,body,start,end,location,isAllDay,attendees,organizer,isOnlineMeeting,onlineMeetingUrl,onlineMeeting,type,responseStatus,categories`;

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
		const colorMap = this.categoryColors ?? new Map<string, string>();
		return allEvents.map(e => parseGraphEvent(e, userEmail, colorMap));
	}

	getUserEmail(): string {
		return this.userEmail ?? "";
	}

	private async fetchMasterCategories(token: string): Promise<void> {
		try {
			const graphBase = this.auth.getGraphBaseUrl();
			const response = await requestUrl({
				url: `${graphBase}/v1.0/me/outlook/masterCategories`,
				method: "GET",
				headers: {Authorization: `Bearer ${token}`},
			});
			const data = response.json as { value?: MasterCategory[] } | MasterCategory[];
			const items = Array.isArray(data) ? data : (data.value ?? []);
			this.categoryColors = new Map();
			for (const cat of items) {
				const hex = PRESET_COLORS[cat.color];
				if (hex) {
					this.categoryColors.set(cat.displayName, hex);
				}
			}
		} catch (e) {
			console.debug("[WhisperCal] Failed to fetch master categories:", e);
			this.categoryColors = new Map();
		}
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

function parseGraphEvent(event: GraphEvent, userEmail: string, colorMap: Map<string, string>): CalendarEvent {
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
		categories: (event.categories ?? []).reduce<EventCategory[]>((acc, name) => {
			const color = colorMap.get(name);
			if (color) acc.push({name, color});
			return acc;
		}, []),
	};
}
