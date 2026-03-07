import {App, Notice, TFile} from "obsidian";
import type {CalendarEvent} from "../types";
import type {PeopleMatchResult} from "./PeopleMatchService";
import {formatDate, formatTime} from "../utils/time";
import {parseDisplayName} from "../utils/nameParser";

/**
 * Build a map of all template variables from a CalendarEvent.
 */
export function buildVariableMap(
	event: CalendarEvent,
	timezone: string,
	peopleMatch?: PeopleMatchResult,
	organizerNotePath?: string | null,
	noteCreated?: Date,
): Record<string, string> {
	const date = formatDate(event.startTime, timezone);
	const startTime = formatTime(event.startTime, timezone);
	const endTime = formatTime(event.endTime, timezone);
	const location = event.location || "N/A";

	// Build a lookup from matched people notes (email → note filename)
	const matchedByEmail = new Map<string, string>();
	const matchedByName = new Map<string, string>();
	if (peopleMatch) {
		for (const m of peopleMatch.matched) {
			const noteName = m.notePath.split("/").pop() ?? m.notePath;
			if (m.email) matchedByEmail.set(m.email.toLowerCase(), noteName);
			if (m.name) matchedByName.set(m.name.toLowerCase(), noteName);
		}
	}

	// Resolve a display name: use people note filename if matched, else parse
	const resolveName = (name: string, email: string): string => {
		return matchedByEmail.get(email.toLowerCase())
			?? matchedByName.get(name.toLowerCase())
			?? parseDisplayName(name, email);
	};

	// Organizer
	const organizerResolved = organizerNotePath
		? (organizerNotePath.split("/").pop() ?? organizerNotePath)
		: resolveName(event.organizerName, event.organizerEmail);
	const organizer = `[[${organizerResolved}]]`;

	// Attendees — every attendee becomes a [[wiki link]]
	const resolvedNames = event.attendees.map(a => resolveName(a.name, a.email));
	const attendees = resolvedNames.map(n => `"[[${n}]]"`).join(", ");
	const attendeeList = resolvedNames.map(n => `- [[${n}]]`).join("\n");
	const invitees = resolvedNames.map(n => `  - "[[${n}]]"`).join("\n");

	return {
		eventId: event.id,
		subject: event.subject,
		date,
		startTime,
		endTime,
		location,
		organizer,
		organizerName: event.organizerName,
		organizerEmail: event.organizerEmail,
		attendeeCount: String(event.attendeeCount),
		attendees,
		attendeeList,
		invitees,
		isOnlineMeeting: String(event.isOnlineMeeting),
		onlineMeetingUrl: event.onlineMeetingUrl || "",
		isAllDay: String(event.isAllDay),
		isRecurring: String(event.isRecurring),
		description: event.body,
		noteCreated: (noteCreated ?? new Date()).toISOString(),
	};
}

/**
 * Replace {{key}} placeholders in a template string.
 * Unknown variables are left as-is.
 */
export function applyTemplate(template: string, variables: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match: string, key: string): string => {
		return key in variables ? (variables[key] as string) : match;
	});
}

/**
 * Load a template from the vault. Returns null with a Notice if
 * the path is empty or the file is not found.
 */
export async function loadTemplate(app: App, path: string): Promise<string | null> {
	if (!path) {
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		new Notice("No meeting note template configured — set one in WhisperCal settings");
		return null;
	}

	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		new Notice(`Template file "${path}" not found — check WhisperCal settings`);
		return null;
	}

	return await app.vault.cachedRead(file);
}
