import {requestUrl} from "obsidian";

/**
 * Anthropic model listing / key validation. Used only to populate the per-prompt
 * model dropdowns — the key is never sent to the LLM CLI.
 *
 * Uses Obsidian's `requestUrl` (no CORS, cross-platform) and an optional-chained
 * `process.env` read.
 */

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 15000;

/** A Claude model as returned by the Anthropic `/v1/models` listing. */
export interface AnthropicModel {
	id: string;
	display_name: string;
}

/**
 * Outcome of a validation attempt. `kind` distinguishes the failure modes the UI
 * words differently: `auth` (key rejected), `http` (bad status), `parse` (2xx but
 * unreadable body — captive portal / proxy HTML), `network` (transport/timeout).
 */
export type ModelListResult =
	| {ok: true; models: AnthropicModel[]}
	| {ok: false; kind: "auth" | "http" | "parse" | "network"; message: string};

/** Resolve the effective Anthropic key: the explicit setting, else the
 *  `ANTHROPIC_API_KEY` env var. */
export function resolveAnthropicKey(explicit: string): string {
	return explicit || globalThis.process?.env?.["ANTHROPIC_API_KEY"] || "";
}

interface ModelEntry { id?: unknown; display_name?: unknown }

/**
 * List the account's Claude models to prove the key works. Races the request
 * against a timeout because `requestUrl` exposes no timeout option — a
 * black-holed request otherwise hangs the caller's "validating" UI forever.
 */
export async function listAnthropicModels(
	apiKey: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ModelListResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ModelListResult>((resolve) => {
		timer = setTimeout(
			() => resolve({ok: false, kind: "network", message: "Timed out contacting Anthropic — check your connection and try again."}),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([listOnce(apiKey), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function listOnce(apiKey: string): Promise<ModelListResult> {
	let response;
	try {
		response = await requestUrl({
			url: MODELS_URL,
			method: "GET",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
			},
			throw: false,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {ok: false, kind: "network", message: `Could not reach Anthropic: ${msg}`};
	}

	if (response.status === 401 || response.status === 403) {
		return {ok: false, kind: "auth", message: "Anthropic rejected this API key. Check the key and try again."};
	}
	if (response.status < 200 || response.status >= 300) {
		return {ok: false, kind: "http", message: `Anthropic returned HTTP ${response.status}. Try again in a moment.`};
	}

	// Parse phase kept separate from transport: a 2xx with a non-JSON body (proxy
	// / captive-portal HTML) throws in the lazy `response.json` getter, and must
	// read as a bad response, not a connectivity failure (finding 2).
	let data: {data?: ModelEntry[]};
	try {
		data = response.json as {data?: ModelEntry[]};
	} catch {
		return {ok: false, kind: "parse", message: "Anthropic returned an unexpected (non-JSON) response. A proxy or captive portal may be intercepting the request."};
	}

	const models = (data.data ?? [])
		.filter((m): m is {id: string; display_name?: unknown} => typeof m?.id === "string")
		.filter((m) => m.id.startsWith("claude-"))
		.map((m) => ({id: m.id, display_name: typeof m.display_name === "string" ? m.display_name : m.id}))
		.sort((a, b) => a.display_name.localeCompare(b.display_name));

	// `has_more`/`last_id` pagination is intentionally not followed: today's Claude
	// catalog is ~10-20 models, well under the 100-item page. Revisit if that grows.
	return {ok: true, models};
}
