import type {App, TFile} from "obsidian";
import {FM} from "../constants";
import type {CalendarEvent, ResponseStatus} from "../types";
import type {PeopleMatchService} from "./PeopleMatchService";
import {resolveAttendeeNames} from "./TemplateEngine";
import {setFrontmatterValues} from "../utils/frontmatter";

/** One RSVP bucket per key; values are `[[Name]]` links, same names as meeting_invitees. */
export type RsvpLists = Record<string, string[]>;

const BUCKET: Record<ResponseStatus, string> = {
	accepted: FM.MEETING_ACCEPTED,
	organizer: FM.MEETING_ACCEPTED,
	tentativelyAccepted: FM.MEETING_TENTATIVE,
	declined: FM.MEETING_DECLINED,
	notResponded: FM.MEETING_NO_RESPONSE,
	none: FM.MEETING_NO_RESPONSE,
};

/** Every RSVP key, in the order they're written to a new note. */
export const RSVP_KEYS = [FM.MEETING_ACCEPTED, FM.MEETING_TENTATIVE, FM.MEETING_DECLINED, FM.MEETING_NO_RESPONSE];

/**
 * Bucket an event's attendees by RSVP. `resolvedNames` is index-aligned with
 * `event.attendees` (see resolveAttendeeNames) so each person links exactly as
 * they do in meeting_invitees. Every key is present, empty or not, so a report
 * can tell "nobody declined" from "not recorded".
 */
export function buildRsvpLists(event: CalendarEvent, resolvedNames: string[]): RsvpLists {
	const lists: RsvpLists = Object.fromEntries(RSVP_KEYS.map(k => [k, [] as string[]]));
	event.attendees.forEach((a, i) => {
		const name = resolvedNames[i];
		if (!name) return;
		const list = lists[BUCKET[a.responseStatus ?? "none"] ?? FM.MEETING_NO_RESPONSE]!;
		const link = `[[${name}]]`;
		if (!list.includes(link)) list.push(link);
	});
	return lists;
}

/**
 * Bring a meeting note's RSVP lists up to date with the calendar. Responses
 * keep changing after the note is created, so this runs on every calendar
 * refresh; it writes only when a list actually differs, so an unchanged
 * meeting never touches the file.
 */
export async function syncRsvpFrontmatter(
	app: App,
	file: TFile,
	event: CalendarEvent,
	peopleSvc: PeopleMatchService,
): Promise<void> {
	if (event.attendees.length === 0) return;
	const lists = buildRsvpLists(event, resolveAttendeeNames(event.attendees, peopleSvc.matchAttendees(event.attendees)));
	const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
	if (fm && RSVP_KEYS.every(k => JSON.stringify(fm[k] ?? null) === JSON.stringify(lists[k]))) return;
	await setFrontmatterValues(app, file.path, lists);
}
