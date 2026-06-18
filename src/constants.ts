import {homedir} from "os";
import {join} from "path";

export const VIEW_TYPE_CALENDAR = "whisper-cal-calendar-view";
export const COMMAND_OPEN_CALENDAR = "open-calendar-view";
export const COMMAND_LINK_RECORDING = "link-macwhisper-recording";
export const COMMAND_TAG_SPEAKERS = "tag-speakers";
export const COMMAND_SUMMARIZE = "summarize-transcript";
export const COMMAND_RESEARCH = "research-meeting";
export const COMMAND_WORD_REPLACE = "run-word-replacements";
export const COMMAND_OPEN_SERIES_NOTE = "open-meeting-series-note";

export const RECORDING_API_PORT_FILE = join(homedir(), "Library", "Application Support", "Tome", "api-port");

const MW_BASE = join(homedir(), "Library", "Application Support", "MacWhisper");
export const MACWHISPER_DB_PATH = join(MW_BASE, "Database", "main.sqlite");
export const MACWHISPER_MEDIA_PATH = join(MW_BASE, "Database", "ExternalMedia");

/**
 * Frontmatter keys read/written across the pipeline. Centralized so renames are mechanical
 * and typos are caught at compile time.
 */
export const FM = {
	PIPELINE_STATE: "pipeline_state",
	MEETING_INVITEES: "meeting_invitees",
	CALENDAR_ATTENDEES: "calendar_attendees",
	INVITEES: "invitees",
	MACWHISPER_SESSION_ID: "macwhisper_session_id",
	MACWHISPER_SESSION_IDS: "macwhisper_session_ids",
	MERGED_FROM: "merged_from",
	TRANSCRIPT: "transcript",
	MEETING_NOTE: "meeting_note",
	CALENDAR_EVENT_ID: "calendar_event_id",
	MEETING_SERIES_ID: "meeting_series_id",
	CONFIRMED_SPEAKERS: "confirmed_speakers",
	VOICEPRINTS: "voiceprints",
	// Research is orthogonal to the linear pipeline (it runs as pre-meeting prep
	// or post-summary), so its completion lives in its own field rather than in
	// pipeline_state, which would otherwise be clobbered by later transcript/
	// summary writes. Set to "research-done" by the plugin on a successful run.
	RESEARCH_STATE: "research_state",
} as const;

/** Valid values written to `pipeline_state` across the pipeline. */
export type PipelineState = "note" | "titled" | "transcript" | "tagged" | "summarized";
