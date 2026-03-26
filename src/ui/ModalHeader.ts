import {parseDateTime, formatRecordingDuration} from "../utils/time";

/**
 * Strip wikilink brackets: "[[John Smith]]" → "John Smith".
 * Also handles aliased links: "[[path|Display]]" → "Display".
 */
function stripWikilink(text: string | undefined): string {
	if (!text) return "";
	const inner = text.replace(/^\[\[|\]\]$/g, "");
	const pipe = inner.indexOf("|");
	return pipe >= 0 ? inner.slice(pipe + 1) : inner;
}

/**
 * Build a meeting subtitle line from frontmatter fields.
 * Format: "9:00 AM – 10:00 AM · 1h · John Smith"
 */
export function buildMeetingSubtitle(fm: Record<string, unknown>): string {
	const meetingDate = fm["meeting_date"] as string | undefined;
	const meetingStart = fm["meeting_start"] as string | undefined;
	const meetingEnd = fm["meeting_end"] as string | undefined;
	const organizer = stripWikilink(fm["meeting_organizer"] as string | undefined);

	const parts: string[] = [];

	// Time range
	if (meetingStart) {
		if (meetingEnd && meetingEnd !== meetingStart) {
			parts.push(`${meetingStart} \u2013 ${meetingEnd}`);
		} else {
			parts.push(meetingStart);
		}
	}

	// Duration (computed from parsed times)
	if (meetingDate && meetingStart && meetingEnd) {
		const start = parseDateTime(meetingDate, meetingStart);
		const end = parseDateTime(meetingDate, meetingEnd);
		if (start && end && end.getTime() > start.getTime()) {
			const durationSec = Math.round((end.getTime() - start.getTime()) / 1000);
			const durText = formatRecordingDuration(durationSec);
			if (durText) parts.push(durText);
		}
	}

	if (organizer) parts.push(organizer);

	return parts.join(" \u00B7 ");
}

/**
 * Render a consistent two-line modal header:
 * Line 1 — meeting name (h3, larger)
 * Line 2 — date/time · duration · organizer (p, smaller/muted)
 */
export function renderModalHeader(el: HTMLElement, title: string, subtitle: string): void {
	el.createEl("h3", {text: title});
	if (subtitle) {
		el.createEl("p", {
			text: subtitle,
			cls: "whisper-cal-modal-subtitle",
		});
	}
}
