import {App, Notice, TFile} from "obsidian";
import type {CalendarEvent, EventAttendee} from "../types";
import type {PeopleMatchResult} from "./PeopleMatchService";
import {formatDate, formatTimeForFrontmatter} from "../utils/time";
import {parseDisplayName} from "../utils/nameParser";
import {yamlEscape} from "../utils/sanitize";

/**
 * Resolve an attendee to the name their wiki link uses: the People-note
 * basename when matched, else a name parsed from the display name / email.
 */
function attendeeNameResolver(peopleMatch?: PeopleMatchResult): (name: string, email: string) => string {
	const matchedByEmail = new Map<string, string>();
	const matchedByName = new Map<string, string>();
	if (peopleMatch) {
		for (const m of peopleMatch.matched) {
			const noteName = m.notePath.split("/").pop() ?? m.notePath;
			if (m.email) matchedByEmail.set(m.email.toLowerCase(), noteName);
			if (m.name) matchedByName.set(m.name.toLowerCase(), noteName);
		}
	}
	return (name, email) => matchedByEmail.get(email.toLowerCase())
		?? matchedByName.get(name.toLowerCase())
		?? parseDisplayName(name, email);
}

/** Resolved link names for `attendees`, index-aligned with the input. */
export function resolveAttendeeNames(attendees: EventAttendee[], peopleMatch?: PeopleMatchResult): string[] {
	const resolveName = attendeeNameResolver(peopleMatch);
	return attendees.map(a => resolveName(a.name, a.email));
}

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
	// Frontmatter-bound (meeting_start/meeting_end come from these variables) —
	// pinned locale so parseDateTime can read the values back.
	const startTime = formatTimeForFrontmatter(event.startTime, timezone);
	const endTime = formatTimeForFrontmatter(event.endTime, timezone);
	const location = event.location || "N/A";

	const resolveName = attendeeNameResolver(peopleMatch);

	// Organizer
	const organizerResolved = organizerNotePath
		? (organizerNotePath.split("/").pop() ?? organizerNotePath)
		: resolveName(event.organizerName, event.organizerEmail);
	const organizer = `[[${organizerResolved}]]`;

	// Attendees — every attendee becomes a [[wiki link]]. The YAML-bound forms
	// (attendees, invitees) escape the name: an unescaped quote in a resolved
	// name would corrupt the whole frontmatter block.
	const resolvedNames = resolveAttendeeNames(event.attendees, peopleMatch);
	const attendees = resolvedNames.map(n => `"[[${yamlEscape(n)}]]"`).join(", ");
	const attendeeList = resolvedNames.map(n => `- [[${n}]]`).join("\n");
	const invitees = resolvedNames.map(n => `  - "[[${yamlEscape(n)}]]"`).join("\n");

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
