import {htmlToMarkdown, requestUrl} from "obsidian";
import type {CalendarAuth} from "./CalendarAuth";

/**
 * Reads the Teams meeting chat behind a calendar event's join URL.
 *
 * The chat is reached by its thread id, which the join URL already carries —
 * `.../l/meetup-join/19%3ameeting_<id>%40thread.v2/0?context=...`. That segment
 * IS the chat resource id, so `GET /chats/{threadId}/messages` needs only the
 * delegated `Chat.Read` scope. Resolving the thread through
 * `/me/onlineMeetings?$filter=JoinWebUrl eq '...'` would additionally need
 * `OnlineMeetings.Read` AND only answers for meetings the signed-in user
 * organized — useless for the majority of meetings, which someone else called.
 */

/** Failure kinds the caller reacts to differently (silent vs. actionable). */
export type TeamsChatErrorKind =
	/** Token lacks Chat.Read, or the user isn't a member of this chat. */
	| "forbidden"
	/** No such chat — meeting chat never created, or the thread was deleted. */
	| "not-found"
	/** Token could not be vended at all (signed out / Core unavailable). */
	| "auth"
	| "network"
	| "other";

export class TeamsChatError extends Error {
	constructor(message: string, readonly kind: TeamsChatErrorKind) {
		super(message);
		this.name = "TeamsChatError";
	}
}

/** One human-authored message, normalized for rendering. */
export interface MeetingChatMessage {
	id: string;
	createdAt: Date;
	authorName: string;
	/** Markdown body — HTML converted, inline images and attachment stubs stripped. */
	markdown: string;
	edited: boolean;
	attachments: {name: string; url: string}[];
}

// ── Graph response shapes ──
interface GraphChatMessage {
	id: string;
	messageType?: string;
	createdDateTime?: string;
	lastEditedDateTime?: string | null;
	deletedDateTime?: string | null;
	from?: {user?: {id?: string; displayName?: string}} | null;
	body?: {contentType?: string; content?: string};
	attachments?: Array<{name?: string | null; contentUrl?: string | null; contentType?: string}>;
}

/** Hard cap on pages walked per pull. 50 messages/page — a very chatty meeting
 *  still fits well inside this, and it bounds a runaway series thread. */
const MAX_PAGES = 20;
const PAGE_SIZE = 50;

/**
 * Pull the chat thread id out of a Teams join URL, or null when the URL isn't a
 * Teams meet-up link (Zoom, a bare web link) or uses a form that doesn't embed
 * the thread — e.g. the short `teams.microsoft.com/meet/<code>` links, which
 * resolve server-side only.
 */
export function extractChatThreadId(joinUrl: string): string | null {
	if (!joinUrl) return null;
	let pathname: string;
	try {
		pathname = new URL(joinUrl).pathname;
	} catch {
		return null; // not a parseable URL
	}
	// Segments are percent-encoded in practice ("19%3ameeting_…%40thread.v2")
	// but some clients hand out the decoded form; decode defensively and accept
	// both. decodeURIComponent throws on a malformed escape — treat as no match.
	for (const segment of pathname.split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			continue;
		}
		// Meeting chats are always `19:meeting_…@thread.v2`; `@thread.skype` is
		// the older channel/group form, accepted so a legacy link still resolves.
		if (/^19:.+@thread\.(v2|skype)$/.test(decoded)) return decoded;
	}
	return null;
}

/**
 * Fetch the messages posted to `threadId` between `from` and `to` (inclusive of
 * neither bound's precision beyond milliseconds), oldest first.
 *
 * Graph returns chat messages newest-first, so paging stops as soon as a page
 * runs older than `from` — a long-lived recurring-series thread costs one page
 * for a normal meeting regardless of how much history sits behind it.
 */
export async function fetchChatMessages(
	auth: CalendarAuth,
	threadId: string,
	from: Date,
	to: Date,
): Promise<MeetingChatMessage[]> {
	let token: string;
	try {
		token = await auth.getAccessToken();
	} catch (e) {
		throw new TeamsChatError(e instanceof Error ? e.message : String(e), "auth");
	}
	const graphBase = auth.getGraphBaseUrl();
	if (!graphBase) {
		throw new TeamsChatError("No Graph base URL — the Microsoft provider is not configured.", "auth");
	}

	const fromMs = from.getTime();
	const toMs = to.getTime();
	const collected: MeetingChatMessage[] = [];

	let url: string | null =
		`${graphBase}/v1.0/chats/${encodeURIComponent(threadId)}/messages?$top=${PAGE_SIZE}`;

	for (let page = 0; url && page < MAX_PAGES; page++) {
		let response;
		try {
			response = await requestUrl({
				url,
				method: "GET",
				headers: {Authorization: `Bearer ${token}`},
				throw: false,
			});
		} catch (e) {
			// requestUrl only rejects on transport failure once throw:false is set.
			throw new TeamsChatError(e instanceof Error ? e.message : String(e), "network");
		}
		if (response.status === 401 || response.status === 403) {
			throw new TeamsChatError(
				`Graph returned ${response.status} for chat ${threadId} — the token is missing Chat.Read, or you are not a member of this chat.`,
				"forbidden",
			);
		}
		if (response.status === 404) {
			throw new TeamsChatError(`No chat thread ${threadId} — the meeting chat may never have been created.`, "not-found");
		}
		if (response.status >= 400) {
			throw new TeamsChatError(`Graph returned ${response.status} for chat ${threadId}.`, "other");
		}

		const data = response.json as {value?: GraphChatMessage[]; "@odata.nextLink"?: string};
		const batch = data.value ?? [];
		let reachedOlderThanWindow = false;

		for (const raw of batch) {
			const createdMs = raw.createdDateTime ? Date.parse(raw.createdDateTime) : NaN;
			if (Number.isNaN(createdMs)) continue;
			// Newest-first ordering: once we are below the window there is nothing
			// newer further down the page set. Flag rather than break so the rest of
			// THIS page is still inspected — ordering is documented, not guaranteed.
			if (createdMs < fromMs) {
				reachedOlderThanWindow = true;
				continue;
			}
			if (createdMs > toMs) continue;
			const message = normalizeMessage(raw, createdMs);
			if (message) collected.push(message);
		}

		if (reachedOlderThanWindow) break;
		url = data["@odata.nextLink"] ?? null;
		if (url && page === MAX_PAGES - 1) {
			// Never silently truncate: a window this far back in a busy thread
			// returns a partial log, and the note gives no hint of that.
			console.warn(`[WhisperCal] Chat ${threadId}: stopped after ${MAX_PAGES} pages without reaching the start of the meeting window — the log may be incomplete.`);
		}
	}

	// Graph hands them back newest-first; a transcript-adjacent log reads
	// chronologically.
	collected.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	return collected;
}

/**
 * Convert one Graph message to the rendered shape, or null when it isn't
 * something a reader wants in the note: system events ("X joined the meeting",
 * "recording started"), deleted messages, and messages whose body converts to
 * nothing and carry no attachment (a lone inline image stub, a bare reaction).
 */
function normalizeMessage(raw: GraphChatMessage, createdMs: number): MeetingChatMessage | null {
	if (raw.deletedDateTime) return null;
	// messageType is absent on some older payloads; only "message" is user-authored.
	if ((raw.messageType ?? "message") !== "message") return null;

	const attachments = (raw.attachments ?? []).reduce<{name: string; url: string}[]>((acc, a) => {
		const url = a.contentUrl ?? "";
		// Teams represents quoted-reply cards and inline-image references as
		// attachments with no contentUrl — nothing to link to, so drop them.
		if (!url) return acc;
		acc.push({name: a.name?.trim() || "Attachment", url});
		return acc;
	}, []);

	const markdown = bodyToMarkdown(raw.body?.content ?? "", raw.body?.contentType ?? "html");
	if (!markdown && attachments.length === 0) return null;

	return {
		id: raw.id,
		createdAt: new Date(createdMs),
		authorName: raw.from?.user?.displayName?.trim() || "Unknown",
		markdown,
		edited: !!raw.lastEditedDateTime,
		attachments,
	};
}

/**
 * Teams message bodies are HTML fragments. `htmlToMarkdown` handles the prose,
 * but two Teams-specific constructs have to go first:
 *
 * - `<img src="…/hostedContents/…/$value">` — inline images and custom emoji.
 *   The URL needs a bearer token, so a markdown image embed renders as a broken
 *   image in the note. Replaced with a plain marker.
 * - `<attachment id="…"></attachment>` — a pointer into the message's
 *   `attachments` array, which is rendered separately. Left in, it converts to
 *   nothing but can leave stray blank lines.
 */
function bodyToMarkdown(content: string, contentType: string): string {
	if (!content.trim()) return "";
	if (contentType === "text") return content.trim();

	const cleaned = content
		.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt.trim() ? `(image: ${alt.trim()})` : "(image)"))
		.replace(/<img\b[^>]*>/gi, "(image)")
		.replace(/<attachment\b[^>]*>.*?<\/attachment>/gis, "")
		.replace(/<attachment\b[^>]*\/?>/gi, "");

	return htmlToMarkdown(cleaned).trim();
}
