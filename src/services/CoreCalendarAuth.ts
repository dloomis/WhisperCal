import {Notice, type App} from "obsidian";
import type {CalendarAuth, AuthState} from "./CalendarAuth";
import {AuthError} from "./CalendarAuth";
import {getWhisperCoreApi} from "./CoreBridge";
import type {CoreProviderId} from "../types/whispercore";

/**
 * The seam that keeps the rest of WhisperCal unchanged after the WhisperCore
 * cutover (DESIGN §8.2). A thin CalendarAuth implementation delegating every
 * member to the WhisperCore API — token storage, refresh, and the loopback
 * sign-in all live in Core now. GraphApiProvider, GoogleCalendarProvider, and
 * both people-search providers construct against the CalendarAuth interface and
 * compile unchanged.
 *
 * The registry is re-fetched (via CoreBridge) on every call, never cached:
 * Core can be disabled mid-session, in which case reads degrade to signed-out
 * and the throwing members surface a NOT_AUTHENTICATED AuthError.
 */
export class CoreCalendarAuth implements CalendarAuth {
	constructor(
		private readonly app: App,
		private readonly provider: CoreProviderId,
	) {}

	/** Core owns token load/persistence; nothing to initialize here. */
	initialize(): void {
		/* no-op */
	}

	getState(): AuthState {
		const api = getWhisperCoreApi(this.app);
		if (!api) return {status: "signed-out"};
		const info = api.getConnectionInfo(this.provider);
		switch (info.state) {
		case "signing-in":
			return info.message !== undefined
				? {status: "signing-in", message: info.message}
				: {status: "signing-in"};
		case "signed-in":
			return {status: "signed-in"};
		case "error":
			return {status: "error", message: info.message ?? "Authentication error"};
		default:
			return {status: "signed-out"};
		}
	}

	isSignedIn(): boolean {
		return getWhisperCoreApi(this.app)?.isSignedIn(this.provider) ?? false;
	}

	/** Graph base URL for the Microsoft cloud Core is configured for (empty for
	 *  Google, whose providers never call this). Was a local CLOUD_ENDPOINTS
	 *  lookup; now sourced from Core's connection info (DESIGN §8.2). */
	getGraphBaseUrl(): string {
		return getWhisperCoreApi(this.app)?.getConnectionInfo(this.provider).graphBaseUrl ?? "";
	}

	async getAccessToken(): Promise<string> {
		const api = getWhisperCoreApi(this.app);
		if (!api) throw new AuthError("WhisperCore is not available.", "NOT_AUTHENTICATED");
		try {
			return await api.getAccessToken(this.provider);
		} catch (e) {
			throw mapCoreError(e);
		}
	}

	async startSignIn(): Promise<void> {
		const api = getWhisperCoreApi(this.app);
		if (!api) {
			// Core absent: nothing to sign into. The gate UI (DESIGN §8.4) already
			// tells the user to install/enable WhisperCore; stay quiet here.
			return;
		}
		try {
			await api.startSignIn(this.provider);
		} catch (e) {
			// Preserve the old CalendarAuth contract: startSignIn never rejects —
			// the outcome (success / cancel / error) is reflected via AuthState,
			// which Core drives through the whispercore:auth-changed event. A
			// user-canceled sign-in is not worth logging.
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.startsWith("WhisperCore API: sign-in canceled")) {
				return; // user closed the browser flow — not worth surfacing
			}
			if (msg.startsWith("WhisperCore API: not configured")) {
				// The provider's tenant/clientId (or Google id/secret) isn't set in
				// Core. Routine re-auth lives in WhisperCal, but configuration lives in
				// Core's settings tab (DESIGN §8.2) — point the user there.
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- product name
				new Notice("Configure your calendar provider in WhisperCore settings first.");
				return;
			}
			console.warn("[WhisperCal] WhisperCore sign-in failed:", msg);
		}
	}

	cancelSignIn(): void {
		getWhisperCoreApi(this.app)?.cancelSignIn(this.provider);
	}

	async signOut(): Promise<void> {
		const api = getWhisperCoreApi(this.app);
		if (!api) return;
		await api.signOut(this.provider);
	}
}

/**
 * Map WhisperCore's stable §5.4 error prefixes back to AuthError codes so the
 * existing downstream handling (NETWORK = transient/keep session, otherwise
 * sign-in-required) keeps working unchanged.
 */
function mapCoreError(e: unknown): AuthError {
	const msg = e instanceof Error ? e.message : String(e);
	if (msg.startsWith("WhisperCore API: network")) return new AuthError(msg, "NETWORK");
	if (msg.startsWith("WhisperCore API: auth failed")) return new AuthError(msg, "AUTH_FAILED");
	// not signed in / not configured / not ready / capability unavailable / canceled
	return new AuthError(msg, "NOT_AUTHENTICATED");
}
