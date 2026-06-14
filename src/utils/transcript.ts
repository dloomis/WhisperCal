/**
 * Shared transcript-body parsing: one definition of "the body" and "a speaker label", used
 * by every speaker-label consumer (the tagging parsers, the review modal's excerpt panel, and
 * the post-processing deletion guard) so their notions can't drift.
 */

/** A speaker-label occurrence in a transcript body. */
export interface SpeakerLabelMatch {
	/** Label text inside the leading `**…**`, trimmed (e.g. "Speaker 2", "You"). */
	name: string;
	/** Start offset of the match within the body string it was found in. */
	pos: number;
}

/**
 * Extract a transcript's body: the text after any leading YAML frontmatter, narrowed to the
 * transcript section (`## Transcript` or `## Full Transcript`) when that heading is present.
 * The single source of truth for "what is the transcript body" across the speaker-tagging
 * parsers and the deletion guard.
 */
export function transcriptBody(content: string): string {
	let body = content;
	// Strip a leading YAML frontmatter block (--- … ---).
	if (body.startsWith("---")) {
		const close = body.indexOf("\n---", 3);
		if (close >= 0) {
			const afterClose = body.indexOf("\n", close + 4);
			body = afterClose >= 0 ? body.slice(afterClose + 1) : "";
		}
	}
	// Narrow to the transcript section when a heading marks it (TranscriptWriter emits
	// "## Full Transcript"; Tome/other formats use "## Transcript").
	const heading = body.search(/^##\s+(?:Full\s+)?Transcript\b/m);
	return heading >= 0 ? body.slice(heading) : body;
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
