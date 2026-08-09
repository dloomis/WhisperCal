import {App, Notice, TFile, requestUrl} from "obsidian";
import type {CalendarAuth} from "./CalendarAuth";
import type {WhisperCalSettings} from "../settings";
import {FM, MEETING_CHAT_HEADING} from "../constants";
import {bodyStartOffset, readFmString} from "../utils/frontmatter";
import {coerceFmDate, coerceFmTime, formatDate, formatTime, parseDateTime} from "../utils/time";
import {PeopleMatchService} from "./PeopleMatchService";
import {
	extractChatThreadId,
	fetchChatMessages,
	TeamsChatError,
	type MeetingChatMessage,
} from "./TeamsChatFetcher";

/**
 * Pulls a Teams meeting's chat into its meeting note under a "## Meeting Chat"
 * section. Runs automatically once a recording's link tail finishes, and on
 * demand from the card's ⋯ menu / the command palette (a re-pull rewrites the
 * section in place, picking up whatever was posted after the call ended).
 *
 * ## Why the section is windowed
 *
 * A recurring Teams meeting series shares ONE chat thread across every
 * occurrence — the thread id in the join URL is identical week to week. Writing
 * the whole thread would duplicate the entire history into every occurrence's
 * note and grow without bound, so only messages inside this occurrence's window
 * are kept: from `PRE_ROLL_MS` before the scheduled start to `POST_ROLL_MS`
 * after the scheduled end.
 */

/** Chat that starts before the call does — "running 5 late", join troubles. */
const PRE_ROLL_MS = 15 * 60 * 1000;
/**
 * Trailing window for post-meeting chatter (the links people promise to send).
 * Generous enough to cover a meeting that ran well past its scheduled end, and
 * short enough that a daily series never reaches the next occurrence.
 */
const POST_ROLL_MS = 4 * 60 * 60 * 1000;
/** Assumed duration when a note carries no `meeting_end` (ad hoc notes). */
const FALLBACK_DURATION_MS = 60 * 60 * 1000;

/** Why a pull produced nothing. Only `error` kinds are worth surfacing. */
export type MeetingChatOutcome =
	| {status: "written"; count: number}
	| {status: "empty"}
	| {status: "skipped"; reason: string}
	| {status: "error"; reason: string; kind: "forbidden" | "not-found" | "auth" | "network" | "other"};

export interface MeetingChatDeps {
	app: App;
	auth: CalendarAuth;
	settings: WhisperCalSettings;
}

/**
 * Resolve → fetch → render → write, for the meeting note at `notePath`.
 *
 * Never throws: every failure comes back as an outcome so the automatic caller
 * (a background link tail) can stay quiet while the manual caller reports.
 */
export async function pullMeetingChat(deps: MeetingChatDeps, notePath: string): Promise<MeetingChatOutcome> {
	const {app, auth, settings} = deps;

	if (settings.calendarProvider !== "microsoft") {
		return {status: "skipped", reason: "Meeting chat is a Microsoft Teams feature."};
	}
	const noteFile = app.vault.getAbstractFileByPath(notePath);
	if (!(noteFile instanceof TFile)) {
		return {status: "skipped", reason: `No meeting note at "${notePath}".`};
	}
	if (!auth.isSignedIn()) {
		return {status: "skipped", reason: "Not signed in to Microsoft 365."};
	}

	const fm = app.metadataCache.getFileCache(noteFile)?.frontmatter;
	const joinUrl = await resolveJoinUrl(deps, noteFile, fm);
	if (!joinUrl) {
		return {status: "skipped", reason: "This meeting has no Teams join link."};
	}
	const threadId = extractChatThreadId(joinUrl);
	if (!threadId) {
		return {status: "skipped", reason: "The meeting's join link carries no Teams chat thread."};
	}

	const chatWindow = resolveWindow(fm, settings.timezone, noteFile);
	let messages: MeetingChatMessage[];
	try {
		messages = await fetchChatMessages(auth, threadId, chatWindow.from, chatWindow.to);
	} catch (e) {
		if (e instanceof TeamsChatError) return {status: "error", reason: e.message, kind: e.kind};
		return {status: "error", reason: e instanceof Error ? e.message : String(e), kind: "other"};
	}

	if (messages.length === 0) {
		// Deliberately does NOT clear an existing section: a re-pull whose window
		// came back empty (transient Graph hiccup, a note whose meeting_start was
		// edited) must not delete a log that was already captured correctly.
		return {status: "empty"};
	}

	const rendered = renderMeetingChat(messages, settings, app);
	try {
		await writeChatSection(app, noteFile, rendered);
	} catch (e) {
		// vault.process can reject (note deleted mid-pull, write conflict). The
		// "never throws" contract is what lets the automatic caller fire this
		// without a catch of its own.
		return {status: "error", reason: e instanceof Error ? e.message : String(e), kind: "other"};
	}
	return {status: "written", count: messages.length};
}

/**
 * The join URL, preferring the note's own stamp. Notes created before
 * `meeting_join_url` existed fall back to re-reading the event from Graph —
 * which only works while the event is still on the calendar, so the stamp is
 * what makes the feature work on old meetings going forward.
 */
async function resolveJoinUrl(
	deps: MeetingChatDeps,
	noteFile: TFile,
	fm: Record<string, unknown> | undefined,
): Promise<string> {
	const stamped = readFmString(fm, FM.MEETING_JOIN_URL);
	if (stamped) return stamped;

	const eventId = readFmString(fm, FM.CALENDAR_EVENT_ID);
	if (!eventId || eventId === "unscheduled") return "";

	try {
		const token = await deps.auth.getAccessToken();
		const graphBase = deps.auth.getGraphBaseUrl();
		if (!graphBase) return "";
		const response = await requestUrl({
			url: `${graphBase}/v1.0/me/events/${encodeURIComponent(eventId)}?$select=onlineMeeting,onlineMeetingUrl`,
			method: "GET",
			headers: {Authorization: `Bearer ${token}`},
			throw: false,
		});
		if (response.status >= 400) return "";
		const data = response.json as {onlineMeeting?: {joinUrl?: string} | null; onlineMeetingUrl?: string | null};
		return data.onlineMeeting?.joinUrl ?? data.onlineMeetingUrl ?? "";
	} catch (e) {
		console.debug(`[WhisperCal] Could not re-read the event for ${noteFile.path}:`, e);
		return "";
	}
}

/** The occurrence's chat window, from the note's own meeting times. */
function resolveWindow(
	fm: Record<string, unknown> | undefined,
	timezone: string,
	noteFile: TFile,
): {from: Date; to: Date} {
	const date = coerceFmDate(fm?.["meeting_date"]);
	const startTime = coerceFmTime(fm?.["meeting_start"]);
	const endTime = coerceFmTime(fm?.["meeting_end"]);

	// Frontmatter times are written in the configured zone (TemplateEngine), so
	// they must be read back in it. A note with no usable times falls back to its
	// own creation time — for an ad hoc note that IS the meeting start.
	const start = (date && startTime ? parseDateTime(date, startTime, timezone) : null)
		?? new Date(noteFile.stat.ctime);
	const end = (date && endTime ? parseDateTime(date, endTime, timezone) : null)
		?? new Date(start.getTime() + FALLBACK_DURATION_MS);

	// A meeting that ends before it starts (hand-edited frontmatter, a meeting
	// crossing midnight where only the date of the start was recorded) would
	// otherwise produce an empty window that silently returns no messages.
	const safeEnd = end.getTime() > start.getTime()
		? end
		: new Date(start.getTime() + FALLBACK_DURATION_MS);

	return {
		from: new Date(start.getTime() - PRE_ROLL_MS),
		to: new Date(safeEnd.getTime() + POST_ROLL_MS),
	};
}

/**
 * Render the log. Authors resolve to `[[People note]]` links when one exists, so
 * the chat participates in the same backlink graph as invitees and confirmed
 * speakers; Graph exposes no email on a chat author, so the match is by display
 * name only.
 */
function renderMeetingChat(messages: MeetingChatMessage[], settings: WhisperCalSettings, app: App): string {
	const peopleSvc = new PeopleMatchService(app, settings.peopleFolderPath);
	const nameCache = new Map<string, string>();
	const resolveAuthor = (name: string): string => {
		const cached = nameCache.get(name);
		if (cached !== undefined) return cached;
		const notePath = peopleSvc.matchOne(name, "");
		const label = notePath
			? `[[${notePath.split("/").pop()?.replace(/\.md$/, "") ?? name}]]`
			: name;
		nameCache.set(name, label);
		return label;
	};

	// A meeting late in the evening can spill past midnight inside the trailing
	// window, where a bare clock time is ambiguous. Date-stamp only the messages
	// that fall on a different day than the conversation started on, so the
	// common case stays uncluttered.
	const firstDay = messages[0] ? formatDate(messages[0].createdAt, settings.timezone) : "";

	const lines: string[] = [];
	for (const m of messages) {
		const day = formatDate(m.createdAt, settings.timezone);
		const stamp = day === firstDay
			? formatTime(m.createdAt, settings.timezone)
			: `${day} ${formatTime(m.createdAt, settings.timezone)}`;
		const edited = m.edited ? " *(edited)*" : "";
		lines.push(`**${resolveAuthor(m.authorName)}** · ${stamp}${edited}`);
		if (m.markdown) {
			// Blockquote the body so a multi-line or list-bearing message stays
			// visually attached to its author line and can't be mistaken for the
			// note's own content.
			lines.push(m.markdown.split("\n").map(l => (l ? `> ${l}` : ">")).join("\n"));
		}
		for (const a of m.attachments) {
			lines.push(`> 📎 [${a.name}](${a.url})`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

/**
 * Write the body under the "## Meeting Chat" heading, replacing the section when
 * one is already there (a re-pull) and appending it at the end of the note
 * otherwise. Section extent is heading → next heading of the same or higher
 * level → end of file, so a deeper heading inside a chat message stays inside.
 */
async function writeChatSection(app: App, noteFile: TFile, body: string): Promise<void> {
	await app.vault.process(noteFile, (content) => upsertChatSection(content, body));
}

/** The pure half of {@link writeChatSection} — exported so the rewrite rules can
 *  be exercised directly against note text. */
export function upsertChatSection(content: string, body: string): string {
	const section = `## ${MEETING_CHAT_HEADING}\n\n${body}\n`;
	const found = findChatSection(content);
	if (!found) {
		const separator = !content ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
		return `${content}${separator}${section}`;
	}
	// The replaced range runs right up to the next heading's `#`, blank-line
	// separator included — put one back so the following heading isn't left
	// glued to the last chat message.
	const gap = found.end < content.length ? "\n" : "";
	return content.slice(0, found.start) + section + gap + content.slice(found.end);
}

/** Character range of an existing chat section, or null when there is none. */
function findChatSection(content: string): {start: number; end: number} | null {
	// Only scan the body: a `## Meeting Chat` line inside the YAML block (as a
	// value in a list, say) is not a heading and must not be rewritten.
	const bodyStart = bodyStartOffset(content);
	const headingRe = new RegExp(`^(#{1,6})[ \\t]+${MEETING_CHAT_HEADING}[ \\t]*$`, "im");
	const match = headingRe.exec(content.slice(bodyStart));
	if (!match) return null;

	const start = bodyStart + match.index;
	const level = (match[1] ?? "##").length;
	// Anchored at a line start, so `#` inside a fenced code block in a message
	// body can't be mistaken for a heading unless it is genuinely at column 0.
	const nextRe = new RegExp(`^#{1,${level}}[ \\t]+\\S`, "m");
	const rest = content.slice(start + match[0].length);
	const nextMatch = nextRe.exec(rest);
	const end = nextMatch
		? start + match[0].length + nextMatch.index
		: content.length;
	return {start, end};
}

/** Report a pull's outcome to the user. Manual invocations only — the automatic
 *  path stays silent for everything but an actionable permission failure. */
export function noticeForOutcome(outcome: MeetingChatOutcome): void {
	switch (outcome.status) {
	case "written":
		new Notice(`Added ${outcome.count} chat message${outcome.count === 1 ? "" : "s"} to the meeting note`);
		break;
	case "empty":
		new Notice("No meeting chat messages found for this meeting");
		break;
	case "skipped":
		new Notice(outcome.reason);
		break;
	case "error":
		new Notice(
			outcome.kind === "forbidden"
				? "Could not read the meeting chat — sign out and back in from WhisperCore so the token includes the Chat.Read permission"
				: `Could not read the meeting chat: ${outcome.reason}`,
			10000,
		);
		break;
	}
}
