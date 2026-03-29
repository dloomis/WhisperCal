import {homedir} from "os";
import {join} from "path";

export const VIEW_TYPE_CALENDAR = "whisper-cal-calendar-view";
export const COMMAND_OPEN_CALENDAR = "open-calendar-view";
export const COMMAND_LINK_RECORDING = "link-macwhisper-recording";
export const COMMAND_TAG_SPEAKERS = "tag-speakers";
export const COMMAND_SUMMARIZE = "summarize-transcript";
export const COMMAND_RESEARCH = "research-meeting";

const MW_BASE = join(homedir(), "Library", "Application Support", "MacWhisper");
export const MACWHISPER_DB_PATH = join(MW_BASE, "Database", "main.sqlite");
export const MACWHISPER_MEDIA_PATH = join(MW_BASE, "Database", "ExternalMedia");

export const TOME_PORT_FILE_PATH = join(homedir(), "Library", "Application Support", "Tome", "api-port");
