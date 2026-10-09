import {requestUrl} from "obsidian";

/**
 * Anthropic model listing. Used only to populate the per-prompt model dropdowns
 * in settings — the key is never sent to the LLM CLI.
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

/** Resolve the effective Anthropic key: the explicit setting, else the
 *  `ANTHROPIC_API_KEY` env var. */
export function resolveAnthropicKey(explicit: string): string {
	return explicit || globalThis.process?.env?.["ANTHROPIC_API_KEY"] || "";
}

interface ModelEntry { id?: unknown; display_name?: unknown }

/**
 * List the account's Claude models, or null when the key is rejected, the
 * response is unusable, or the request fails. Races the request against a
 * timeout because `requestUrl` exposes no timeout option — a black-holed
 * request would otherwise never settle, and the caller only retries after a
 * null result.
 */
export async function listAnthropicModels(
	apiKey: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AnthropicModel[] | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	try {
		return await Promise.race([listOnce(apiKey), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function listOnce(apiKey: string): Promise<AnthropicModel[] | null> {
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
	} catch {
		return null;
	}
	if (response.status < 200 || response.status >= 300) return null;

	// A 2xx with a non-JSON body (proxy / captive-portal HTML) throws in the
	// lazy `response.json` getter.
	let data: {data?: ModelEntry[]};
	try {
		data = response.json as {data?: ModelEntry[]};
	} catch {
		return null;
	}

	// `has_more`/`last_id` pagination is intentionally not followed: today's Claude
	// catalog is ~10-20 models, well under the 100-item page. Revisit if that grows.
	return (data.data ?? [])
		.filter((m): m is {id: string; display_name?: unknown} => typeof m?.id === "string")
		.filter((m) => m.id.startsWith("claude-"))
		.map((m) => ({id: m.id, display_name: typeof m.display_name === "string" ? m.display_name : m.id}))
		.sort((a, b) => a.display_name.localeCompare(b.display_name));
}
