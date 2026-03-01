import {execSync} from "child_process";
import {join} from "path";
import {MACWHISPER_DB_PATH, MACWHISPER_MEDIA_PATH} from "../constants";

export interface MacWhisperRecording {
	sessionId: string; // hex
	title: string | null;
	recordingStart: Date;
	durationSeconds: number;
}

interface SessionRow {
	sessionId: string;
	title: string | null;
	mediaFilename: string;
	duration: number | null;
}

interface TranscriptLineRow {
	speaker: string | null;
	text: string;
	startMs: number;
}

interface SessionMetadataRow {
	title: string | null;
	dateCreated: string;
	hasBeenDiarized: number;
	modelEngine: string | null;
	modelIdentifer: string | null;
	modelInputLanguage: string | null;
	detectedLanguage: string | null;
	aiTitle: string | null;
	aiSummary: string | null;
	durationSec: number | null;
	appName: string | null;
}

export interface TranscriptData {
	lines: TranscriptLineRow[];
	metadata: SessionMetadataRow | null;
	speakers: string[];
}

/**
 * Query the MacWhisper SQLite database to find and link recordings.
 * Uses `sqlite3` CLI — no npm dependencies needed.
 */

function query(sql: string, readonly = true): string {
	const flags = readonly ? "-readonly" : "";
	// Collapse newlines/tabs to spaces so JSON.stringify won't produce
	// \n / \t literals that sqlite3 can't parse as SQL tokens.
	const flat = sql.replace(/[\n\t]+/g, " ").trim();
	const cmd = `sqlite3 ${flags} -json "${MACWHISPER_DB_PATH}" ${JSON.stringify(flat)}`;
	try {
		return execSync(cmd, {encoding: "utf-8", timeout: 5000}).trim();
	} catch {
		return "[]";
	}
}

function parseRows<T>(raw: string): T[] {
	if (!raw || raw === "[]") return [];
	try {
		return JSON.parse(raw) as T[];
	} catch {
		return [];
	}
}

/**
 * Convert a 32-char hex session ID to UUID format for filesystem lookups.
 * e.g. "AABBCCDD11223344AABBCCDD11223344" → "AABBCCDD-1122-3344-AABB-CCDD11223344"
 */
function hexToUuid(hex: string): string {
	const h = hex.toUpperCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Get the filesystem birthtime of the track-0 media file for a session.
 * ExternalMedia is a flat directory with files named:
 *   {UUID}_track-0_{hash}.m4a
 *   {UUID}_merged-audio_{hash}.m4a
 *   etc.
 * Track-0 birthtime = actual recording start time.
 */
function getTrack0Birthtime(sessionId: string): Date | null {
	const uuid = hexToUuid(sessionId);
	const prefix = `${uuid}_track-0_`;
	try {
		// Use stat on the expected filename pattern via shell glob
		const cmd = `stat -f "%B" "${join(MACWHISPER_MEDIA_PATH, prefix)}"*.m4a`;
		const raw = execSync(cmd, {encoding: "utf-8", shell: "/bin/zsh", timeout: 3000}).trim();
		if (!raw) return null;
		// stat -f "%B" returns birthtime as epoch seconds
		const epoch = parseInt(raw.split("\n")[0]!, 10);
		if (isNaN(epoch)) return null;
		return new Date(epoch * 1000);
	} catch {
		return null;
	}
}

/**
 * Find MacWhisper recordings whose track-0 birthtime is within
 * ±windowMinutes of the given meeting start time.
 */
export function findRecordingsNear(
	meetingStart: Date,
	windowMinutes = 10,
): MacWhisperRecording[] {
	// Join session → mediafile for track-0, and session → SAR for duration
	const sql = `
		SELECT hex(s.id) as sessionId,
		       s.userChosenTitle as title,
		       mf.filename as mediaFilename,
		       sar.duration as duration
		FROM session s
		JOIN mediafile mf ON mf.sessionId = s.id
		LEFT JOIN systemaudiorecording sar ON s.systemAudioRecordingID = sar.id
		WHERE s.isTransient = 0
		  AND s.dateDeleted IS NULL
		  AND mf.filename LIKE '%_track-0_%'
		ORDER BY s.dateCreated DESC
		LIMIT 50;
	`;
	const raw = query(sql);
	const rows = parseRows<SessionRow>(raw);

	const windowMs = windowMinutes * 60 * 1000;
	const results: MacWhisperRecording[] = [];

	for (const row of rows) {
		const birthtime = getTrack0Birthtime(row.sessionId);
		if (!birthtime) continue;

		const diff = Math.abs(birthtime.getTime() - meetingStart.getTime());
		if (diff <= windowMs) {
			results.push({
				sessionId: row.sessionId,
				title: row.title || null,
				recordingStart: birthtime,
				durationSeconds: row.duration ? Math.round(row.duration) : 0,
			});
		}
	}

	return results;
}

/**
 * Set the user-chosen title on a MacWhisper session.
 * Returns true if the update succeeded, false on error.
 */
export function setSessionTitle(sessionId: string, title: string): boolean {
	const escaped = title.replace(/'/g, "''");
	const sql = `UPDATE session SET userChosenTitle = '${escaped}' WHERE hex(id) = '${sessionId}';`;
	const flat = sql.replace(/[\n\t]+/g, " ").trim();
	const cmd = `sqlite3 -json "${MACWHISPER_DB_PATH}" ${JSON.stringify(flat)}`;
	try {
		execSync(cmd, {encoding: "utf-8", timeout: 5000});
		return true;
	} catch (err) {
		console.error("[WhisperCal] setSessionTitle failed:", err);
		return false;
	}
}

/**
 * Fetch full transcript data for a session: lines with speaker attribution,
 * session metadata, and speaker list.
 */
export function getTranscript(sessionId: string): TranscriptData {
	// 1. Transcript lines with speaker names and start timestamps
	//    tl.start is already in milliseconds; speakerID has capital D
	const linesSql = `
		SELECT sp.name as speaker,
		       tl.text as text,
		       tl.start as startMs
		FROM transcriptline tl
		LEFT JOIN speaker sp ON tl.speakerID = sp.id
		WHERE hex(tl.sessionId) = '${sessionId}'
		ORDER BY tl.start ASC;
	`;
	const lines = parseRows<TranscriptLineRow>(query(linesSql));

	// 2. Session metadata (actual column names from MacWhisper schema)
	const metaSql = `
		SELECT s.userChosenTitle as title,
		       s.dateCreated as dateCreated,
		       s.hasBeenDiarized as hasBeenDiarized,
		       s.modelEngine as modelEngine,
		       s.modelIdentifer as modelIdentifer,
		       s.modelInputLanguage as modelInputLanguage,
		       s.detectedLanguage as detectedLanguage,
		       s.aiTitle as aiTitle,
		       s.aiSummary as aiSummary,
		       sar.duration as durationSec,
		       rm.appName as appName
		FROM session s
		LEFT JOIN systemaudiorecording sar ON s.systemAudioRecordingID = sar.id
		LEFT JOIN recordedmeeting rm ON s.recordedMeetingID = rm.id
		WHERE hex(s.id) = '${sessionId}';
	`;
	const metaRows = parseRows<SessionMetadataRow>(query(metaSql));
	const metadata = metaRows[0] ?? null;

	// 3. Speaker list (session_speaker uses capital D: speakerID)
	const speakersSql = `
		SELECT DISTINCT sp.name as name
		FROM session_speaker ss
		JOIN speaker sp ON ss.speakerID = sp.id
		WHERE hex(ss.sessionID) = '${sessionId}'
		ORDER BY sp.name ASC;
	`;
	const speakerRows = parseRows<{name: string}>(query(speakersSql));
	const speakers = speakerRows.map(r => r.name);

	return {lines, metadata, speakers};
}
