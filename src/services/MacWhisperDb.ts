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

/**
 * Query the MacWhisper SQLite database to find and link recordings.
 * Uses `sqlite3` CLI — no npm dependencies needed.
 */

function query(sql: string, readonly = true): string {
	const flags = readonly ? "-readonly" : "";
	const cmd = `sqlite3 ${flags} -json "${MACWHISPER_DB_PATH}" ${JSON.stringify(sql)}`;
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
 */
export function setSessionTitle(sessionId: string, title: string): void {
	const escaped = title.replace(/'/g, "''");
	const sql = `UPDATE session SET userChosenTitle = '${escaped}' WHERE hex(id) = '${sessionId}';`;
	query(sql, false);
}
