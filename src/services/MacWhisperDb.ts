import {execSync} from "child_process";
import {join} from "path";
import {statSync} from "fs";
import {readdirSync} from "fs";
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
 * This represents the actual recording start time.
 */
function getTrack0Birthtime(sessionId: string): Date | null {
	const uuid = hexToUuid(sessionId);
	const sessionDir = join(MACWHISPER_MEDIA_PATH, uuid);
	try {
		const files = readdirSync(sessionDir);
		const track0 = files.find(f => f.includes("_track-0_"));
		if (!track0) return null;
		const stat = statSync(join(sessionDir, track0));
		return stat.birthtime;
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
	const sql = `
		SELECT hex(s.id) as sessionId,
		       s.userChosenTitle as title,
		       mf.filename as mediaFilename
		FROM session s
		JOIN mediafile mf ON mf.sessionId = s.id
		WHERE s.isTransient = 0
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
			// Estimate duration from the media file size or just use 0
			// We can get duration from the DB if needed
			results.push({
				sessionId: row.sessionId,
				title: row.title || null,
				recordingStart: birthtime,
				durationSeconds: 0,
			});
		}
	}

	// Populate duration from systemaudiorecording table
	for (const rec of results) {
		const durSql = `
			SELECT sar.duration
			FROM systemaudiorecording sar
			JOIN session s ON s.id = sar.sessionId
			WHERE hex(s.id) = '${rec.sessionId}'
			LIMIT 1;
		`;
		const durRaw = query(durSql);
		const durRows = parseRows<{duration: number}>(durRaw);
		if (durRows.length > 0 && durRows[0]) {
			rec.durationSeconds = Math.round(durRows[0].duration);
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
