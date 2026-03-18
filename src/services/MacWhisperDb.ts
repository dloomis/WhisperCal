import {execFile} from "child_process";
import {readdirSync, statSync} from "fs";
import {join} from "path";
import {MACWHISPER_DB_PATH, MACWHISPER_MEDIA_PATH} from "../constants";
import {debug} from "../utils/debug";

export interface MacWhisperRecording {
	sessionId: string; // hex
	title: string | null;
	recordingStart: Date;
	/** session.dateCreated — matches the timestamp MacWhisper displays in its UI. */
	dateCreated: Date | null;
	durationSeconds: number;
	speakerCount: number;
}

interface SessionRow {
	sessionId: string;
	title: string | null;
	dateCreated: string | null;
	mediaFilename: string;
	duration: number | null;
	speakerCount: number;
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

/**
 * Parse a MacWhisper dateCreated string (UTC, e.g. "2026-03-18 18:12:42.251")
 * into a JS Date. Returns null if the string is missing or unparseable.
 */
function parseDateCreated(raw: string | null): Date | null {
	if (!raw) return null;
	// Append "Z" so Date.parse treats it as UTC
	const d = new Date(raw.replace(" ", "T") + "Z");
	return isNaN(d.getTime()) ? null : d;
}

const RECORDING_MATCH_LIMIT = 50;
const RECENT_SESSION_LIMIT = 200;

/** Validate that a string is a hex-encoded session ID (safe for SQL interpolation). */
function isValidHexId(id: string): boolean {
	return /^[0-9A-Fa-f]+$/.test(id) && id.length > 0;
}

/**
 * Query the MacWhisper SQLite database to find and link recordings.
 * Uses `sqlite3` CLI — no npm dependencies needed.
 */

function query(sql: string): Promise<string> {
	const flags = ["-readonly", "-json"];
	// Collapse newlines/tabs to spaces for clean SQL
	const flat = sql.replace(/[\n\t]+/g, " ").trim();
	return new Promise((resolve) => {
		execFile(
			"sqlite3",
			[...flags, MACWHISPER_DB_PATH, flat],
			{encoding: "utf-8", timeout: 5000},
			(err, stdout) => {
				if (err) {
					console.warn("[WhisperCal] SQLite query failed:", err.message);
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
 * Get the filesystem birthtime of a media file for a session.
 * Prefers track-0 (actual recording start for MacWhisper-recorded sessions),
 * but falls back to any media file (e.g. _transcription_ for imports).
 */
function getMediaBirthtime(sessionId: string): Date | null {
	const uuid = hexToUuid(sessionId);
	const sessionPrefix = `${uuid}_`;
	try {
		const files = readdirSync(MACWHISPER_MEDIA_PATH);
		const sessionFiles = files.filter(f => f.startsWith(sessionPrefix) && f.endsWith(".m4a"));
		// Prefer track-0, fall back to any media file
		const match = sessionFiles.find(f => f.includes("_track-0_")) ?? sessionFiles[0];
		if (!match) return null;
		const stats = statSync(join(MACWHISPER_MEDIA_PATH, match));
		return stats.birthtime;
	} catch {
		return null;
	}
}

/** Shared SQL for fetching session rows with media file and speaker count. */
const SESSION_LIST_SQL = `
	SELECT hex(s.id) as sessionId,
	       s.userChosenTitle as title,
	       s.dateCreated as dateCreated,
	       mf.filename as mediaFilename,
	       sar.duration as duration,
	       (SELECT COUNT(*) FROM session_speaker ss2 WHERE ss2.sessionID = s.id) as speakerCount
	FROM session s
	JOIN mediafile mf ON mf.sessionId = s.id
		AND mf.id = (
			SELECT id FROM mediafile m2
			WHERE m2.sessionId = s.id
			ORDER BY (m2.filename LIKE '%_track-0_%') DESC
			LIMIT 1
		)
	LEFT JOIN systemaudiorecording sar ON s.systemAudioRecordingID = sar.id
	WHERE s.isTransient = 0
	  AND s.dateDeleted IS NULL
	  AND (sar.dateDeleted IS NULL OR s.systemAudioRecordingID IS NULL)
	ORDER BY s.dateCreated DESC
`;

async function fetchSessionRows(limit: number): Promise<SessionRow[]> {
	const sql = `${SESSION_LIST_SQL} LIMIT ${limit};`;
	const raw = await query(sql);
	return parseRows<SessionRow>(raw);
}

/**
 * Find MacWhisper recordings whose track-0 birthtime is within
 * ±windowMinutes of the given meeting start time.
 */
export async function findRecordingsNear(
	meetingStart: Date,
	windowMinutes = 10,
): Promise<MacWhisperRecording[]> {
	const rows = await fetchSessionRows(RECORDING_MATCH_LIMIT);

	debug("MacWhisperDb", "findRecordingsNear: meetingStart=%s (%d), window=%d min, rows=%d",
		meetingStart.toISOString(), meetingStart.getTime(), windowMinutes, rows.length);

	const windowMs = windowMinutes * 60 * 1000;
	const results: MacWhisperRecording[] = [];

	const birthtimes = rows.map(row => getMediaBirthtime(row.sessionId));

	const nullCount = birthtimes.filter(b => b === null).length;
	debug("MacWhisperDb", "findRecordingsNear: resolved %d birthtimes, %d null", birthtimes.length, nullCount);

	for (let i = 0; i < rows.length; i++) {
		const birthtime = birthtimes[i];
		if (!birthtime) continue;

		const row = rows[i]!;
		const diff = Math.abs(birthtime.getTime() - meetingStart.getTime());
		const diffMin = diff / 60000;
		if (diff <= windowMs) {
			debug("MacWhisperDb", "MATCH: session=%s title=%s birthtime=%s diff=%.1f min",
				row.sessionId, row.title, birthtime.toISOString(), diffMin);
			results.push({
				sessionId: row.sessionId,
				title: row.title || null,
				recordingStart: birthtime,
				dateCreated: parseDateCreated(row.dateCreated),
				durationSeconds: row.duration ? Math.round(row.duration) : 0,
				speakerCount: row.speakerCount,
			});
		} else if (diffMin < 120) {
			debug("MacWhisperDb", "NEAR-MISS: session=%s title=%s birthtime=%s diff=%.1f min",
				row.sessionId, row.title, birthtime.toISOString(), diffMin);
		}
	}

	debug("MacWhisperDb", "findRecordingsNear: returning %d matches", results.length);
	return results;
}

/**
 * Fetch all recent MacWhisper sessions within a time window,
 * filtered by track-0 birthtime. Returns sessions older than
 * `gracePeriodHours` but newer than `lookbackDays`.
 */
export async function findRecentSessions(
	lookbackDays: number,
): Promise<MacWhisperRecording[]> {
	const rows = await fetchSessionRows(RECENT_SESSION_LIMIT);

	const now = Date.now();
	const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
	const results: MacWhisperRecording[] = [];

	for (const row of rows) {
		const birthtime = getMediaBirthtime(row.sessionId);
		if (!birthtime) continue;

		const age = now - birthtime.getTime();
		if (age <= lookbackMs) {
			results.push({
				sessionId: row.sessionId,
				title: row.title || null,
				recordingStart: birthtime,
				dateCreated: parseDateCreated(row.dateCreated),
				durationSeconds: row.duration ? Math.round(row.duration) : 0,
				speakerCount: row.speakerCount,
			});
		}
	}

	return results;
}

/**
 * Check whether any transcript lines exist for a session.
 * Used to detect whether MacWhisper has finished transcribing.
 */
export async function hasTranscriptLines(sessionId: string): Promise<boolean> {
	if (!isValidHexId(sessionId)) return false;
	const sql = `SELECT COUNT(*) as cnt FROM transcriptline WHERE hex(sessionId) = '${sessionId}' LIMIT 1;`;
	const raw = await query(sql);
	const rows = parseRows<{cnt: number}>(raw);
	return (rows[0]?.cnt ?? 0) > 0;
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
