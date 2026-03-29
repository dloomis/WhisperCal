import {requestUrl} from "obsidian";
import {readFileSync} from "fs";
import {TOME_PORT_FILE_PATH} from "../constants";

export type TomeState = "idle" | "recording" | "transcribing" | "complete";

let cachedBaseUrl: string | null = null;

function getBaseUrl(): string {
	if (cachedBaseUrl) return cachedBaseUrl;

	let port: string;
	try {
		port = readFileSync(TOME_PORT_FILE_PATH, "utf-8").trim();
	} catch {
		throw new Error("Tome is not installed (port file not found)");
	}
	if (!port || isNaN(Number(port))) {
		throw new Error("Tome port file is invalid");
	}
	cachedBaseUrl = `http://127.0.0.1:${port}/api/v1`;
	return cachedBaseUrl;
}

/** Clear cached port so it's re-read on next call (e.g. after connection failure). */
function resetBaseUrl(): void {
	cachedBaseUrl = null;
}

async function tomeRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
	const url = getBaseUrl() + path;

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
		resetBaseUrl();
		throw new Error("Tome is not running");
	}

	if (response.status >= 400) {
		throw new Error(`Tome API error: ${response.status} ${response.text}`);
	}

	return response.json as T;
}

export async function tomeHealth(): Promise<{modelsReady: boolean; isRecording: boolean}> {
	return tomeRequest("GET", "/health");
}

export async function tomeStart(
	suggestedFilename: string,
	meetingContext?: {subject: string; attendees: string[]},
): Promise<void> {
	await tomeRequest("POST", "/start", {suggestedFilename, meetingContext});
}

export async function tomeStop(): Promise<void> {
	await tomeRequest("POST", "/stop");
}

export async function tomeStatus(): Promise<{state: TomeState}> {
	return tomeRequest("GET", "/status");
}
