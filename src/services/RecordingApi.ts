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

	return response.json as T;
}

export async function recordingHealth(baseUrl: string): Promise<{modelsReady: boolean; isRecording: boolean}> {
	return apiRequest("GET", `${baseUrl}/health`);
}

export async function recordingStart(
	baseUrl: string,
	suggestedFilename: string,
	meetingContext?: {subject: string; attendees: string[]},
): Promise<void> {
	await apiRequest("POST", `${baseUrl}/start`, {suggestedFilename, meetingContext});
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
	return {state, subject: extractRecordingSubject(obj), startedAt: extractStartedAt(obj)};
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
