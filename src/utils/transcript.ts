/**
 * Shared transcript-body parsing: one definition of "the body" and "a speaker label", used
 * by every speaker-label consumer (the tagging parsers, the review modal's excerpt panel, and
 * the post-processing deletion guard) so their notions can't drift.
 */

import {bodyStartOffset} from "./frontmatter";

/** A speaker-label occurrence in a transcript body. */
export interface SpeakerLabelMatch {
	/** Label text inside the leading `**…**`, trimmed (e.g. "Speaker 2", "You"). */
	name: string;
	/** Start offset of the match within the body string it was found in. */
	pos: number;
}

/**
 * Offset at which the transcript's spoken lines start: the `## Transcript` /
 * `## Full Transcript` heading when present, else the start of the body. Callers that
 * rewrite speaker labels slice from here so they can't touch a summary or table above it.
 */
export function transcriptStartOffset(content: string): number {
	const start = bodyStartOffset(content);
	// TranscriptWriter emits "## Full Transcript"; Tome/other formats use "## Transcript".
	const heading = content.slice(start).search(/^##\s+(?:Full\s+)?Transcript\b/m);
	return heading >= 0 ? start + heading : start;
}

/**
 * Extract a transcript's body: the text after any leading YAML frontmatter, narrowed to the
 * transcript section (`## Transcript` or `## Full Transcript`) when that heading is present.
 * The single source of truth for "what is the transcript body" across the speaker-tagging
 * parsers and the deletion guard.
 */
export function transcriptBody(content: string): string {
	return content.slice(transcriptStartOffset(content));
}

/**
 * Find every speaker-label line (`**Label**` at the start of a line) in `body`, in document
 * order, each with its start offset. Pass the exact string you will slice from — typically
 * transcriptBody(content). Non-speaker bold lines (a label ending in ":" or a "Duration …"
 * metadata line) are skipped.
 */
export function findSpeakerLabels(body: string): SpeakerLabelMatch[] {
	const out: SpeakerLabelMatch[] = [];
	const re = /^\*\*(.+?)\*\*/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		const name = m[1]!.trim();
		if (!name || name.endsWith(":") || /^Duration\b/.test(name)) continue;
		out.push({name, pos: m.index});
	}
	return out;
}

/**
 * True when `body` still carries Tome's live-call-leg placeholder label ("Them") on a
 * speaker line. Tome writes the transcript to the vault from session start using this
 * placeholder (alongside "You") and only replaces it with real diarized "Speaker N"
 * labels once its finalizer runs — a step that can take 1-3 minutes after the meeting
 * note is linked. Any consumer that reads speaker labels off the body (auto-tagging,
 * proposal writers) must treat a "Them" hit as "Tome isn't done yet" rather than as a
 * real, stable speaker name — writing proposals against it freezes wrong groups that
 * Tome's own finalizer will never retroactively fix (it only patches its own inline
 * `attendees: […]` form, not an already-expanded object list).
 *
 * Pass the same string you'd pass to findSpeakerLabels — typically transcriptBody(content).
 */
export function hasLiveLegLabels(body: string): boolean {
	return findSpeakerLabels(body).some(({name}) => name === "Them");
}
