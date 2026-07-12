/**
 * Vendored WhisperCore public-API types.
 *
 * VERBATIM hand-copy of the vendorable block from `../WhisperCore/src/api.ts`
 * (WhisperCore 0.1.0 — WHISPERCORE_API_VERSION 1). Copied 2026-07-12
 * (LlmConfigDto extended with the migrated LLM-engine fields; version integer
 * held at 1 pending the v1-additive-vs-v2 decision).
 *
 * The block is dependency-free by contract (WhisperCore DESIGN §3), so it
 * compiles standalone — no import, no npm link. Re-copy this whole block on
 * every WHISPERCORE_API_VERSION bump; the runtime `apiVersion` check in
 * CoreBridge is the drift alarm. Do NOT edit the block by hand.
 */

// ── consumer-facing types (vendorable) — keep dependency-free ──
export const WHISPERCORE_API_VERSION = 1;

export type CoreProviderId = "microsoft" | "google";

export interface CoreCapabilities {
	/** False on mobile (loopback OAuth needs Node http + shell.openExternal). */
	auth: boolean;
	/** LLM credential/config vending — always true (plain strings, platform-free). */
	llmConfig: boolean;
}

export interface ConnectionInfoDto {
	provider: CoreProviderId;
	state: "signed-out" | "signing-in" | "signed-in" | "error";
	message?: string;              // present when state === "error" or "signing-in"
	/** Microsoft only: the Graph base URL for the configured cloud (e.g. GCC High
	 *  "https://graph.microsoft.us"). Consumers use this for their own HTTP calls. */
	graphBaseUrl?: string;
	cloudInstance?: string;        // Microsoft only; one of the CLOUD_ENDPOINTS keys
	/** True when the provider's required config fields are filled in Core settings
	 *  (tenant/clientId, or Google id/secret) — lets consumers distinguish
	 *  "not configured" from "configured but signed out" in their gate UI. */
	configured: boolean;
}

export interface LlmConfigDto {
	cli: string;                   // e.g. "claude"
	extraFlags: string;            // base flags shared by all consumers
	anthropicApiKey: string | null; // null when unset (consumers fall back to env)
	promptDir: string;             // shared vault folder holding LLM prompt files ("" when unset)
	timeoutMinutes: number;        // kill an LLM process after this many minutes (0 = no timeout)
	maxConcurrent: number;         // machine-wide cap on concurrent LLM processes
	debugMode: boolean;            // open LLM commands in a terminal instead of running headless
	debugLogging: boolean;         // log detailed LLM diagnostics to the developer console
}

/** One-time migration intake (DESIGN §8.3). Fills EMPTY Core slots only; never overwrites. */
export interface CoreImportBundle {
	microsoft?: { tenantId?: string; clientId?: string; cloudInstance?: string;
		tokenCache?: { accessToken: string; refreshToken: string; expiresAt: number } };
	google?: { clientId?: string; clientSecret?: string;
		tokenCache?: { accessToken: string; refreshToken: string; expiresAt: number } };
	llm?: { anthropicApiKey?: string; cli?: string; extraFlags?: string };
}

export interface CoreImportResult {
	adopted: string[];             // dotted paths actually written, e.g. "microsoft.tokenCache"
	skipped: string[];             // provided but Core slot was already filled
}

/** All inputs/outputs are plain JSON — no TFile, no internal types, no class instances. */
export interface WhisperCoreApi {
	readonly apiVersion: number;   // === WHISPERCORE_API_VERSION
	/** True once onload completes. Reads before ready return safe defaults, never throw. */
	isReady(): boolean;
	capabilities(): CoreCapabilities;

	// ── Connections (reads — never throw) ──
	getConnectionInfo(provider: CoreProviderId): ConnectionInfoDto;
	isSignedIn(provider: CoreProviderId): boolean;

	// ── Connections (async / throwing — DESIGN §5.4 prefixes) ──
	/** Vend a short-lived access token, transparently refreshing (single-flight,
	 *  5-min expiry buffer — semantics identical to BaseCalendarAuth.getAccessToken). */
	getAccessToken(provider: CoreProviderId): Promise<string>;
	/** Run the interactive loopback sign-in. Resolves on success; throws on
	 *  failure/cancel. Also invocable from Core's own settings tab. */
	startSignIn(provider: CoreProviderId): Promise<void>;
	cancelSignIn(provider: CoreProviderId): void;
	signOut(provider: CoreProviderId): Promise<void>;

	// ── LLM (reads — never throw) ──
	getLlmConfig(): LlmConfigDto;

	// ── Migration (write — DESIGN §8.3; deprecated from birth, removed in v2) ──
	importConfig(bundle: CoreImportBundle): Promise<CoreImportResult>;
}
// ── end vendorable block ──

// ── Ambient augmentation: `app.plugins` is community-standard but unofficial
//    (WhisperCore DESIGN §8.1; shared with the planned OrgBridge). Every access
//    MUST be optional-chained and treated as fallible. ──
declare module "obsidian" {
	interface App {
		plugins?: {
			getPlugin(id: string): Plugin | null;
			enabledPlugins: Set<string>;
		};
	}
}
