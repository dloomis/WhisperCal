import {execFile, exec} from "child_process";
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

export interface SpeakerInfo {
	name: string;
	id: string;
	isStub: boolean;
	lineCount: number;
}

export interface TranscriptData {
	lines: TranscriptLineRow[];
	metadata: SessionMetadataRow | null;
	speakers: SpeakerInfo[];
}

/** Validate that a string is a hex-encoded session ID (safe for SQL interpolation). */
function isValidHexId(id: string): boolean {
	return /^[0-9A-Fa-f]+$/.test(id) && id.length > 0;
}

/**
 * Query the MacWhisper SQLite database to find and link recordings.
 * Uses `sqlite3` CLI — no npm dependencies needed.
 */

function query(sql: string, readonly = true): Promise<string> {
	const flags = readonly ? ["-readonly", "-json"] : ["-json"];
	// Collapse newlines/tabs to spaces for clean SQL
	const flat = sql.replace(/[\n\t]+/g, " ").trim();
	return new Promise((resolve) => {
		execFile(
			"sqlite3",
			[...flags, MACWHISPER_DB_PATH, flat],
			{encoding: "utf-8", timeout: 5000},
			(err, stdout) => {
				if (err) {
					resolve("[]");
				} else {
					resolve(stdout.trim());
				}
			},
		);
	});
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
function getTrack0Birthtime(sessionId: string): Promise<Date | null> {
	const uuid = hexToUuid(sessionId);
	const prefix = `${uuid}_track-0_`;
	// Use stat on the expected filename pattern via shell glob
	const cmd = `stat -f "%B" "${join(MACWHISPER_MEDIA_PATH, prefix)}"*.m4a`;
	return new Promise((resolve) => {
		exec(cmd, {encoding: "utf-8", shell: "/bin/zsh", timeout: 3000}, (err, stdout) => {
			if (err || !stdout.trim()) {
				resolve(null);
				return;
			}
			// stat -f "%B" returns birthtime as epoch seconds
			const epoch = parseInt(stdout.trim().split("\n")[0]!, 10);
			if (isNaN(epoch)) {
				resolve(null);
			} else {
				resolve(new Date(epoch * 1000));
			}
		});
	});
}

/**
 * Find MacWhisper recordings whose track-0 birthtime is within
 * ±windowMinutes of the given meeting start time.
 */
export async function findRecordingsNear(
	meetingStart: Date,
	windowMinutes = 10,
): Promise<MacWhisperRecording[]> {
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
	const raw = await query(sql);
	const rows = parseRows<SessionRow>(raw);

	console.debug("[WhisperCal] findRecordingsNear: meetingStart=%s (%d), window=%d min, rows=%d",
		meetingStart.toISOString(), meetingStart.getTime(), windowMinutes, rows.length);

	const windowMs = windowMinutes * 60 * 1000;
	const results: MacWhisperRecording[] = [];

	// Resolve all birthtimes concurrently
	const birthtimes = await Promise.all(
		rows.map(row => getTrack0Birthtime(row.sessionId)),
	);

	const nullCount = birthtimes.filter(b => b === null).length;
	console.debug("[WhisperCal] findRecordingsNear: resolved %d birthtimes, %d null", birthtimes.length, nullCount);

	for (let i = 0; i < rows.length; i++) {
		const birthtime = birthtimes[i];
		if (!birthtime) continue;

		const row = rows[i]!;
		const diff = Math.abs(birthtime.getTime() - meetingStart.getTime());
		const diffMin = diff / 60000;
		if (diff <= windowMs) {
			console.debug("[WhisperCal] MATCH: session=%s title=%s birthtime=%s diff=%.1f min",
				row.sessionId, row.title, birthtime.toISOString(), diffMin);
			results.push({
				sessionId: row.sessionId,
				title: row.title || null,
				recordingStart: birthtime,
				durationSeconds: row.duration ? Math.round(row.duration) : 0,
			});
		} else if (diffMin < 120) {
			console.debug("[WhisperCal] NEAR-MISS: session=%s title=%s birthtime=%s diff=%.1f min",
				row.sessionId, row.title, birthtime.toISOString(), diffMin);
		}
	}

	console.debug("[WhisperCal] findRecordingsNear: returning %d matches", results.length);
	return results;
}

/**
 * Set the user-chosen title on a MacWhisper session.
 * Returns true if the update succeeded, false on error.
 */
export async function setSessionTitle(sessionId: string, title: string): Promise<boolean> {
	if (!isValidHexId(sessionId)) return false;
	const escaped = title.replace(/'/g, "''");
	const sql = `UPDATE session SET userChosenTitle = '${escaped}' WHERE hex(id) = '${sessionId}';`;
	const flat = sql.replace(/[\n\t]+/g, " ").trim();
	return new Promise((resolve) => {
		execFile(
			"sqlite3",
			[MACWHISPER_DB_PATH, flat],
			{encoding: "utf-8", timeout: 5000},
			(err) => {
				if (err) {
					console.error("[WhisperCal] setSessionTitle failed:", err);
					resolve(false);
				} else {
					resolve(true);
				}
			},
		);
	});
}

/**
 * Fetch full transcript data for a session: lines with speaker attribution,
 * session metadata, and speaker list.
 */
export async function getTranscript(sessionId: string): Promise<TranscriptData> {
	if (!isValidHexId(sessionId)) return {lines: [], metadata: null, speakers: []};

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

	// 3. Speaker list with id, stub flag, and line count
	const speakersSql = `
		SELECT sp.name as name,
		       hex(sp.id) as id,
		       sp.isStub as isStub,
		       COALESCE(lc.cnt, 0) as lineCount
		FROM session_speaker ss
		JOIN speaker sp ON ss.speakerID = sp.id
		LEFT JOIN (
			SELECT tl.speakerID, COUNT(*) as cnt
			FROM transcriptline tl
			WHERE hex(tl.sessionId) = '${sessionId}'
			GROUP BY tl.speakerID
		) lc ON lc.speakerID = sp.id
		WHERE hex(ss.sessionID) = '${sessionId}'
		ORDER BY sp.name ASC;
	`;

	// Run all three queries concurrently
	const [linesRaw, metaRaw, speakersRaw] = await Promise.all([
		query(linesSql),
		query(metaSql),
		query(speakersSql),
	]);

	const lines = parseRows<TranscriptLineRow>(linesRaw);
	const metaRows = parseRows<SessionMetadataRow>(metaRaw);
	const metadata = metaRows[0] ?? null;
	const speakerRows = parseRows<{name: string; id: string; isStub: number; lineCount: number}>(speakersRaw);
	const speakers: SpeakerInfo[] = speakerRows.map(r => ({
		name: r.name,
		id: r.id,
		isStub: r.isStub === 1,
		lineCount: r.lineCount,
	}));

	return {lines, metadata, speakers};
}
