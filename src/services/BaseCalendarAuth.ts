import type {TokenCache, AuthState} from "./AuthTypes";
import type {CalendarAuth} from "./CalendarAuth";
import {AuthError} from "./CalendarAuth";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface AuthCallbacks {
	loadTokenCache(): TokenCache | null;
	saveTokenCache(cache: TokenCache | null): Promise<void>;
	onStateChange(state: AuthState): void;
}

/**
 * Shared base for MsalAuth and GoogleAuth.
 * Handles token caching, expiry, state management, and sign-out.
 * Subclasses implement startSignIn() and doRefreshToken().
 */
export abstract class BaseCalendarAuth implements CalendarAuth {
	protected callbacks: AuthCallbacks;
	protected tokenCache: TokenCache | null = null;
	protected state: AuthState = {status: "signed-out"};
	private refreshPromise: Promise<string> | null = null;

	constructor(callbacks: AuthCallbacks) {
		this.callbacks = callbacks;
	}

	initialize(): void {
		this.tokenCache = this.callbacks.loadTokenCache();
		this.setState(this.tokenCache ? {status: "signed-in"} : {status: "signed-out"});
	}

	abstract updateConfig(config: Record<string, string>): void;
	abstract startSignIn(): Promise<void>;

	getState(): AuthState {
		return this.state;
	}

	isSignedIn(): boolean {
		return this.tokenCache !== null;
	}

	async getAccessToken(): Promise<string> {
		if (!this.tokenCache) {
			throw new AuthError("Not signed in.", "NOT_AUTHENTICATED");
		}

		if (Date.now() < this.tokenCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
			return this.tokenCache.accessToken;
		}

		return this.refreshAccessToken();
	}

	async signOut(): Promise<void> {
		this.cancelSignIn();
		this.tokenCache = null;
		await this.callbacks.saveTokenCache(null);
		this.setState({status: "signed-out"});
	}

	abstract cancelSignIn(): void;

	protected setState(state: AuthState): void {
		this.state = state;
		this.callbacks.onStateChange(state);
	}

	protected async saveToken(cache: TokenCache): Promise<void> {
		this.tokenCache = cache;
		await this.callbacks.saveTokenCache(cache);
	}

	/** Subclasses implement the provider-specific token refresh. */
	protected abstract doRefreshToken(refreshToken: string): Promise<TokenCache>;

	private async refreshAccessToken(): Promise<string> {
		// Deduplicate concurrent refresh calls — if a refresh is already in-flight,
		// return the same promise to avoid rotating the refresh token multiple times.
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.doRefresh();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	private async doRefresh(): Promise<string> {
		if (!this.tokenCache?.refreshToken) {
			await this.signOut();
			throw new AuthError("No refresh token. Please sign in again.", "NOT_AUTHENTICATED");
		}

		try {
			const newCache = await this.doRefreshToken(this.tokenCache.refreshToken);
			await this.saveToken(newCache);
			return newCache.accessToken;
		} catch (e) {
			// A NETWORK failure is transient — leave the cached refresh token intact
			// so the next attempt (once connectivity returns) can succeed. Signing
			// out here would persist a null cache and force a full browser re-auth
			// for a passing Wi-Fi/VPN hiccup.
			if (e instanceof AuthError && e.code === "NETWORK") throw e;
			// AUTH_FAILED (bad grant) and any other error mean the credentials are
			// no longer usable — surface as a sign-in-required condition. Preserve a
			// specific AuthError; wrap anything else.
			if (e instanceof AuthError) throw e;
			await this.signOut();
			throw new AuthError("Session expired. Please sign in again.", "NOT_AUTHENTICATED");
		}
	}
}
