import {App, Notice, TFile, requestUrl} from "obsidian";
import type {CalendarAuth} from "./CalendarAuth";
import type {WhisperCalSettings} from "../settings";
import {FM, MEETING_CHAT_HEADING} from "../constants";
import {bodyStartOffset, readFmString} from "../utils/frontmatter";
import {coerceFmDate, coerceFmTime, formatDate, formatTime, parseDateTime, parseDurationSeconds} from "../utils/time";
import {resolveWikiLink} from "../utils/vault";
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
 * A meeting chat thread is not the meeting. Two things make an unwindowed pull
 * wrong rather than merely noisy:
 *
 * - A recurring series shares ONE thread across every occurrence — the thread id
 *   in the join URL is identical week to week — so the whole history would land
 *   in every occurrence's note.
 * - The thread stays live all day after the call. Everything posted to it later
 *   is a different conversation that happens to share an address.
 *
 * So the window is the meeting itself: `GRACE_MS` either side of start and end,
 * where "end" is the later of the scheduled end and how long the recording
 * actually ran (see {@link resolveWindow}).
 *
 * Note what this costs: a re-pull applies the SAME window, so messages posted
 * well after the call never reach the note by any path. That is the intended
 * trade — the section is a record of the meeting, and widening it is a matter
 * of raising `GRACE_MS`.
 */

/**
 * Grace on each side of the meeting. Small on purpose: the section should read
 * as the conversation that happened *during* the call, not the thread's whole
 * afternoon. It covers only the edges that genuinely belong to the meeting —
 * "joining now" a minute early, a reply landing just after someone hangs up,
 * and the fact that Teams timestamps and calendar times don't agree to the
 * second. Post-meeting chatter is what the manual re-pull is for.
 */
const GRACE_MS = 5 * 60 * 1000;
/** Assumed duration when a note has neither `meeting_end` nor a recording. */
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

	const chatWindow = resolveWindow(app, fm, settings.timezone, noteFile);
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

/**
 * The occurrence's chat window: the meeting itself, plus {@link GRACE_MS} on
 * each side.
 *
 * The end is whichever is later — the scheduled end, or how long the recording
 * actually ran. A meeting that goes 25 minutes over keeps chatting for those 25
 * minutes, and the scheduled end would cut the log off mid-conversation; the
 * transcript's own `duration` is the honest record of when it really finished.
 * A meeting that ends early keeps its scheduled end, which costs nothing (there
 * is simply no chat in the empty tail).
 */
function resolveWindow(
	app: App,
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
	const scheduledEnd = date && endTime ? parseDateTime(date, endTime, timezone) : null;

	// An end at or before the start (hand-edited frontmatter, a meeting crossing
	// midnight where only the start's date was recorded) would otherwise produce
	// an empty window that silently returns no messages.
	let end = scheduledEnd && scheduledEnd.getTime() > start.getTime()
		? scheduledEnd
		: new Date(start.getTime() + FALLBACK_DURATION_MS);

	const recordedMs = recordedDurationMs(app, fm, noteFile.path);
	if (recordedMs > 0) {
		const recordedEnd = new Date(start.getTime() + recordedMs);
		if (recordedEnd.getTime() > end.getTime()) end = recordedEnd;
	}

	return {
		from: new Date(start.getTime() - GRACE_MS),
		to: new Date(end.getTime() + GRACE_MS),
	};
}

/**
 * How long the linked recording ran, in ms, or 0 when there is no transcript,
 * no `duration` on it, or the note isn't linked yet (the automatic pull runs
 * right after linking, so the transcript is normally there by then).
 */
function recordedDurationMs(app: App, fm: Record<string, unknown> | undefined, notePath: string): number {
	if (!fm) return 0;
	const transcript = resolveWikiLink(app, fm, FM.TRANSCRIPT, notePath);
	if (!transcript) return 0;
	const transcriptFm = app.metadataCache.getFileCache(transcript)?.frontmatter;
	return parseDurationSeconds(transcriptFm?.["duration"]) * 1000;
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
