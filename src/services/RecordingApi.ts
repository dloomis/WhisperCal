import {requestUrl} from "obsidian";
import {readFileSync} from "fs";
import {RECORDING_API_PORT_FILE} from "../constants";

export type RecordingState = "idle" | "recording" | "transcribing" | "complete";

export interface RecordingStatus {
	state: RecordingState;
	/** Subject/title the service reports for the in-progress recording, when it provides one. */
	subject?: string;
	/**
	 * Epoch milliseconds when the service actually began capturing, when it
	 * reports it. Used to anchor WhisperCal's elapsed timer to the service's clock
	 * so the two stay in sync (both run on the same machine).
	 */
	startedAt?: number;
	/**
	 * Correlation guid of the live capture, when the service reports it
	 * (SESSION_GUID_DESIGN.md) — lets callers tell WHOSE capture is live before
	 * acting on the global state (e.g. skipping /stop for a foreign session).
	 */
	sessionGuid?: string;
}

/**
 * Resolve the effective recording API base URL.
 * Uses the configured URL if set, otherwise auto-detects from the
 * Tome port file (the port is dynamic and changes on each launch).
 */
export function resolveRecordingApiBaseUrl(configuredUrl: string): string {
	if (configuredUrl) return configuredUrl;
	try {
		const port = readFileSync(RECORDING_API_PORT_FILE, "utf-8").trim();
		if (port && /^\d+$/.test(port)) {
			return `http://localhost:${port}`;
		}
	} catch {
		// Port file not found or not readable
	}
	return "";
}

/**
 * True when an error thrown out of the recording API means the service is not
 * listening — i.e. Tome isn't running. Both apiRequest paths convert a refused
 * connection to "Recording API is not reachable"; match that signal so callers
 * can distinguish "Tome is down, tell the user to start it" from a genuine
 * service-side failure (already recording, models loading, HTTP 4xx/5xx).
 */
export function isRecordingServiceUnreachableError(err: unknown): boolean {
	return err instanceof Error && err.message.toLowerCase().includes("not reachable");
}

async function apiRequest<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
	let response;
	try {
		response = await requestUrl({
			url,
			method,
			headers: body ? {"Content-Type": "application/json"} : undefined,
			body: body ? JSON.stringify(body) : undefined,
			throw: false,
		});
	} catch {
		throw new Error("Recording API is not reachable");
	}

	if (response.status >= 400) {
		throw new Error(`Recording API error: ${response.status} ${response.text}`);
	}

	// A 2xx with an unparseable body must not throw — every caller treats the
	// body defensively (recordingStart degrades to unacknowledged, recordingStatus
	// to "idle"), and a hard error here would abort flows the service accepted.
	try {
		return response.json as T;
	} catch {
		return {} as T;
	}
}

export async function recordingHealth(baseUrl: string): Promise<{modelsReady: boolean; isRecording: boolean}> {
	return apiRequest("GET", `${baseUrl}/health`);
}

export interface RecordingStartResult {
	/**
	 * True iff the service echoed back the sessionGuid we sent — the signal that
	 * it will thread the guid through status/transcript/sidecar. An older service
	 * returns bare `{"ok":true}`; callers then fall back to the legacy
	 * filename-based linking flow for this session (SESSION_GUID_DESIGN.md).
	 */
	guidAcknowledged: boolean;
	/** The service's internal session id, informational only — it is a
	 *  second-granular timestamp and collidable; never use it as a correlation key. */
	sessionId?: string;
}

export async function recordingStart(
	baseUrl: string,
	suggestedFilename: string,
	meetingContext: {subject: string; attendees: string[]} | undefined,
	sessionGuid: string,
): Promise<RecordingStartResult> {
	const raw = await apiRequest<unknown>("POST", `${baseUrl}/start`, {sessionGuid, suggestedFilename, meetingContext});
	const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	return {
		guidAcknowledged: obj["sessionGuid"] === sessionGuid,
		sessionId: typeof obj["sessionId"] === "string" ? obj["sessionId"] : undefined,
	};
}

export async function recordingStop(baseUrl: string): Promise<void> {
	await apiRequest("POST", `${baseUrl}/stop`);
}

export async function recordingStatus(baseUrl: string): Promise<RecordingStatus> {
	const raw = await apiRequest<unknown>("GET", `${baseUrl}/status`);
	// Tolerate older/unknown service versions: a non-object body or a missing
	// `state` field must not throw. Only a literal "recording" state ever gates the
	// UI, so anything unrecognized degrades to a benign "idle" (callers proceed).
	const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	const state = typeof obj["state"] === "string" ? obj["state"] as RecordingState : "idle";
	return {state, subject: extractRecordingSubject(obj), startedAt: extractStartedAt(obj), sessionGuid: extractSessionGuid(obj)};
}

export type SessionGuidState = "recording" | "transcribing" | "complete" | "failed" | "unknown";

export interface SessionGuidStatus {
	state: SessionGuidState;
	/** FINAL transcript basename (incl. `.md`, after collision suffixes/renames). Present when complete. */
	transcriptFilename?: string;
	/** Epoch ms the capture began. Present while recording. */
	startedAt?: number;
	/** Failure detail from the service. Present when failed. */
	error?: string;
}

/**
 * Per-session status keyed by the correlation guid — `GET /sessions/by-guid/{guid}/status`
 * (SESSION_GUID_DESIGN.md). Unlike the global /status, this stays unambiguous when a prior
 * session is post-processing while a new one records. A 404 maps to state "unknown"
 * (guid never seen, or evicted from the service's finished-session retention window);
 * network errors still throw, like recordingStatus, so callers can tell the two apart.
 */
export async function recordingSessionStatus(baseUrl: string, sessionGuid: string): Promise<SessionGuidStatus> {
	let response;
	try {
		response = await requestUrl({
			url: `${baseUrl}/sessions/by-guid/${encodeURIComponent(sessionGuid)}/status`,
			method: "GET",
			throw: false,
		});
	} catch {
		throw new Error("Recording API is not reachable");
	}
	if (response.status === 404) return {state: "unknown"};
	if (response.status >= 400) {
		throw new Error(`Recording API error: ${response.status} ${response.text}`);
	}

	let raw: unknown;
	try {
		raw = response.json;
	} catch {
		raw = {};
	}
	const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	const state = obj["state"];
	// An unrecognized state (newer service) degrades to "unknown" so callers fall
	// back to file-based matching quickly instead of polling a state they can't
	// interpret until timeout.
	const known: SessionGuidState[] = ["recording", "transcribing", "complete", "failed"];
	const startedAtIso = typeof obj["startedAt"] === "string" ? Date.parse(obj["startedAt"]) : NaN;
	return {
		state: typeof state === "string" && (known as string[]).includes(state) ? state as SessionGuidState : "unknown",
		transcriptFilename: typeof obj["transcriptFilename"] === "string" && obj["transcriptFilename"] ? obj["transcriptFilename"] : undefined,
		startedAt: Number.isFinite(startedAtIso) ? startedAtIso : undefined,
		error: typeof obj["error"] === "string" && obj["error"] ? obj["error"] : undefined,
	};
}

/**
 * Pull the recording's start time (epoch ms) out of a /status payload, so the UI
 * timer can anchor to the service's clock. Accepts a top-level or nested value
 * under a few plausible field names, and normalizes a seconds-epoch to ms.
 * Returns undefined when absent — the UI then keeps its own local anchor.
 */
function extractStartedAt(raw: Record<string, unknown>): number | undefined {
	const num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
	const nested = (v: unknown): number | undefined => {
		if (!v || typeof v !== "object") return undefined;
		const o = v as Record<string, unknown>;
		return num(o["startedAt"]) ?? num(o["startTime"]) ?? num(o["started_at"]);
	};
	const ts =
		num(raw["startedAt"]) ?? num(raw["startTime"]) ?? num(raw["started_at"]) ??
		nested(raw["recording"]) ?? nested(raw["currentRecording"]);
	if (ts === undefined) return undefined;
	// Normalize a seconds-epoch (~1.7e9) to milliseconds (~1.7e12).
	return ts < 1e12 ? ts * 1000 : ts;
}

/**
 * Pull the live capture's session guid out of a /status payload. The design puts
 * it under `recording.sessionGuid`; also accept a top-level or currentRecording
 * placement, mirroring the other extractors. Returns undefined when absent — an
 * older service then simply gets no identity check.
 */
function extractSessionGuid(raw: Record<string, unknown>): string | undefined {
	const str = (v: unknown): string | undefined =>
		typeof v === "string" && v.trim() ? v.trim() : undefined;
	const nested = (v: unknown): string | undefined => {
		if (!v || typeof v !== "object") return undefined;
		return str((v as Record<string, unknown>)["sessionGuid"]);
	};
	return str(raw["sessionGuid"]) ?? nested(raw["recording"]) ?? nested(raw["currentRecording"]);
}

/**
 * Pull the in-progress recording's title out of a /status payload. The recording
 * service hasn't pinned down where it reports this, so accept the first non-empty
 * string from a few plausible locations (top-level or nested). Returns undefined
 * when absent — the confirm modal then falls back to a generic message.
 */
function extractRecordingSubject(raw: Record<string, unknown>): string | undefined {
	const str = (v: unknown): string | undefined =>
		typeof v === "string" && v.trim() ? v.trim() : undefined;
	const nested = (v: unknown): string | undefined => {
		if (!v || typeof v !== "object") return undefined;
		const o = v as Record<string, unknown>;
		return str(o["subject"]) ?? str(o["suggestedFilename"]) ?? str(o["title"]);
	};
	return (
		str(raw["subject"]) ??
		str(raw["meeting"]) ??
		str(raw["title"]) ??
		nested(raw["recording"]) ??
		nested(raw["currentRecording"]) ??
		nested(raw["meetingContext"])
	);
}
