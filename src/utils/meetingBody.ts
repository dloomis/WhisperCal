/**
 * Remove an online-meeting "join" block (Teams / Zoom) from a meeting note's
 * markdown body, leaving the agenda. The body is the htmlToMarkdown-converted
 * calendar event description, in which Outlook/Teams brackets the join block
 * with horizontal-rule lines (a long run of underscores) and always appends it
 * after the agenda.
 *
 * A block is only removed when it clearly belongs to a provider: it must
 * contain a provider header (e.g. "Microsoft Teams meeting"), or a Teams/Zoom
 * join URL together with at least one join detail (Meeting ID, Passcode,
 * dial-in, ...), or at least two such details on their own. This guard keeps a
 * user's own divider, an agenda line mentioning "join", or a join URL quoted in
 * agenda prose from being removed.
 */
import {TEAMS_HOSTS, ZOOM_HOSTS, hostMatches} from "./meetingHosts";

const ALL_MEETING_HOSTS = [...TEAMS_HOSTS, ...ZOOM_HOSTS];

/** A markdown thematic break or a run of the same rule char (Teams' divider). */
function isRuleLine(line: string): boolean {
	return /^\s{0,3}(?:[_*-]\s*){3,}$/.test(line);
}

/** A definitive provider header — enough on its own to mark a join block. */
function hasHeaderMarker(text: string): boolean {
	const t = text.toLowerCase();
	return t.includes("microsoft teams meeting") || t.includes("join zoom meeting");
}

/** True when the text contains a Teams/Zoom join URL. */
function hasJoinHost(text: string): boolean {
	const urlRe = /https?:\/\/([^/\s)"']+)/gi;
	let m: RegExpExecArray | null;
	while ((m = urlRe.exec(text)) !== null) {
		if (m[1] && hostMatches(m[1].toLowerCase(), ALL_MEETING_HOSTS)) return true;
	}
	return false;
}

/** Weak markers: individual join details (meeting id, passcode, dial-in, ...). */
const WEAK_PATTERNS: RegExp[] = [
	/^\s*join:/im,
	/meeting id:/i,
	/passcode:/i,
	/dial in by phone/i,
	/find a local number/i,
	/conference id:/i,
	/for organizers:/i,
];

/**
 * A provider join block has a definitive header, or a join URL alongside at
 * least one join detail, or two-plus details on their own. A join URL merely
 * quoted in agenda prose (no header, no details) does NOT qualify — that guards
 * against silently deleting agenda text.
 */
function isJoinBlock(text: string): boolean {
	if (hasHeaderMarker(text)) return true;
	const weak = WEAK_PATTERNS.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
	if (hasJoinHost(text) && weak >= 1) return true;
	return weak >= 2;
}

export function stripJoinBlock(body: string): string {
	const lines = body.split("\n");
	const ruleIdx: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (isRuleLine(lines[i]!)) ruleIdx.push(i);
	}

	const remove = new Array<boolean>(lines.length).fill(false);

	// Bracketed blocks: the region between two consecutive rule lines.
	for (let r = 0; r + 1 < ruleIdx.length; r++) {
		const open = ruleIdx[r]!;
		const close = ruleIdx[r + 1]!;
		const inner = lines.slice(open + 1, close).join("\n");
		if (isJoinBlock(inner)) {
			for (let i = open; i <= close; i++) remove[i] = true;
		}
	}

	// Trailing block: a rule line whose region to end-of-body qualifies and
	// that wasn't already consumed as a closing rule.
	if (ruleIdx.length > 0) {
		const last = ruleIdx[ruleIdx.length - 1]!;
		if (!remove[last]) {
			const tail = lines.slice(last + 1).join("\n");
			if (isJoinBlock(tail)) {
				for (let i = last; i < lines.length; i++) remove[i] = true;
			}
		}
	}

	const removedAny = remove.some(Boolean);
	const kept = lines.filter((_, i) => !remove[i]);
	// Removing a join block can strand a divider that used to sit just above it
	// (e.g. a user's own "---" right before Outlook's bracketing rule). Drop
	// trailing rule/blank lines left behind — but only when we actually removed a
	// block, so a body with no join block keeps its own trailing divider intact.
	if (removedAny) {
		while (kept.length > 0) {
			const last = kept[kept.length - 1]!;
			if (last.trim() === "" || isRuleLine(last)) kept.pop();
			else break;
		}
	}
	// Collapse over-large blank runs left by removal; trim trailing whitespace.
	return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}
