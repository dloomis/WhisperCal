import {requestUrl} from "obsidian";
import {readFileSync} from "fs";
import {RECORDING_API_PORT_FILE} from "../constants";

export type RecordingState = "idle" | "recording" | "transcribing" | "complete";

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

export async function recordingStatus(baseUrl: string): Promise<{state: RecordingState}> {
	return apiRequest("GET", `${baseUrl}/status`);
}
