import {requestUrl} from "obsidian";
import {createHash, randomBytes} from "crypto";
import type {TokenCache, TokenResponse, AuthState} from "./AuthTypes";
import type {CalendarAuth} from "../CalendarAuth";
import {AuthError} from "../CalendarAuth";
import {LoopbackOAuthServer} from "./LoopbackOAuthServer";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface AuthCallbacks {
	loadTokenCache(): TokenCache | null;
	saveTokenCache(cache: TokenCache | null): Promise<void>;
	onStateChange(state: AuthState): void;
}

/**
 * Provider-specific hooks the shared sign-in flow drives (template method — C1).
 * `runSignInFlow` owns everything common (in-flight guard, PKCE/state generation,
 * loopback lifecycle, browser open, timeout/cancel handling, save, state); the
 * subclass supplies only the URLs and the code→token exchange.
 */
export interface SignInFlow {
	/** Returns a user-facing error message when required config is missing, else null. */
	validateConfig(): string | null;
	/** The loopback redirect URI for the captured port. */
	redirectUri(port: number): string;
	/** The provider authorize URL (with PKCE challenge + CSRF state embedded). */
	buildAuthUrl(redirectUri: string, codeChallenge: string, state: string): string;
	/** Exchange the authorization code for a token cache (via `postTokenRequest`). */
	exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenCache>;
}

/**
 * Shared base for MsalAuth and GoogleAuth.
 * Handles token caching, expiry, state management, sign-out, and the whole
 * interactive loopback sign-in flow. Subclasses supply provider URLs/params via
 * `SignInFlow` and implement `doRefreshToken()` (built on `postTokenRequest`).
 */
export abstract class BaseCalendarAuth<C> implements CalendarAuth {
	protected config: C;
	protected callbacks: AuthCallbacks;
	protected tokenCache: TokenCache | null = null;
	protected state: AuthState = {status: "signed-out"};
	protected readonly loopback = new LoopbackOAuthServer();
	private refreshPromise: Promise<string> | null = null;
	/** In-flight sign-in, if any — a second startSignIn returns this instead of
	 *  racing a second loopback server (finding 3). */
	private signInPromise: Promise<void> | null = null;
	/** Fingerprint of the identity config in effect when `tokenCache` was minted.
	 *  A mismatch at refresh time means the config was edited since sign-in, so a
	 *  refresh failure is attributable to the edit, not a dead grant (finding 1). */
	private tokenConfigFingerprint: string | null = null;
	/** Set once a refresh has failed under an edited identity config: the held
	 *  token is kept (the edit may be half-typed) but the state reads as an error
	 *  so the UI prompts a re-auth instead of showing a healthy session. */
	private configMismatch = false;
	/** Bumped whenever the session is replaced (sign-out, fresh sign-in, reload
	 *  from disk). An in-flight refresh or code exchange that started under an
	 *  older epoch must not write its token back. */
	private sessionEpoch = 0;

	constructor(config: C, callbacks: AuthCallbacks) {
		this.config = config;
		this.callbacks = callbacks;
	}

	initialize(): void {
		this.tokenCache = this.callbacks.loadTokenCache();
		// The persisted cache was minted under the persisted config (they load
		// together), so the current fingerprint is the token's fingerprint.
		this.tokenConfigFingerprint = this.configFingerprint();
		this.setState(this.stateFromCache());
	}

	updateConfig(config: C): void {
		this.config = config;
		// Editing the config back to what the token was minted under makes the
		// held session good again.
		if (this.configMismatch && !this.configChangedSinceMint()) {
			this.configMismatch = false;
			this.setState(this.stateFromCache());
		}
	}

	/** Re-read the persisted cache after data.json changed underneath us (a sync
	 *  from another machine), so the live session matches what is on disk. */
	reloadTokenCache(): void {
		const cache = this.callbacks.loadTokenCache();
		const held = this.tokenCache;
		if (cache?.refreshToken === held?.refreshToken
			&& cache?.accessToken === held?.accessToken
			&& cache?.expiresAt === held?.expiresAt) return;
		this.invalidateInFlight();
		this.tokenCache = cache;
		this.tokenConfigFingerprint = cache ? this.configFingerprint() : null;
		this.configMismatch = false;
		// An interactive sign-in owns the state until it settles.
		if (this.state.status !== "signing-in") this.setState(this.stateFromCache());
	}

	/** Microsoft overrides with the configured cloud's Graph base URL; Google's
	 *  providers never call this. */
	getGraphBaseUrl(): string {
		return "";
	}

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

		// A token is only good under the config it was minted for (a cloud change
		// would send it to another cloud's Graph host), so an edited config forces
		// a refresh under the new one.
		if (!this.configChangedSinceMint()
			&& Date.now() < this.tokenCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
			return this.tokenCache.accessToken;
		}

		return this.refreshAccessToken();
	}

	async signOut(): Promise<void> {
		this.cancelSignIn();
		this.invalidateInFlight();
		this.tokenCache = null;
		this.tokenConfigFingerprint = null;
		this.configMismatch = false;
		await this.callbacks.saveTokenCache(null);
		this.setState({status: "signed-out"});
	}

	cancelSignIn(): void {
		this.loopback.stop();
	}

	protected setState(state: AuthState): void {
		this.state = state;
		this.callbacks.onStateChange(state);
	}

	/** The state implied by the current cache: signed-in if a token is held, else
	 *  signed-out. Used to restore a live session after a cancelled/failed re-auth
	 *  so `isSignedIn()` (cache-based) and `getState()` never disagree (finding 8). */
	protected stateFromCache(): AuthState {
		if (!this.tokenCache) return {status: "signed-out"};
		if (this.configMismatch) {
			return {
				status: "error",
				message: "Provider settings changed since sign-in. Sign in again, or restore the previous settings.",
				code: "AUTH_FAILED",
			};
		}
		return {status: "signed-in"};
	}

	private invalidateInFlight(): void {
		this.sessionEpoch++;
		this.refreshPromise = null;
	}

	protected async saveToken(cache: TokenCache): Promise<void> {
		this.tokenCache = cache;
		this.tokenConfigFingerprint = this.configFingerprint();
		this.configMismatch = false;
		await this.callbacks.saveTokenCache(cache);
	}

	/** A stable string over the identity config that scopes a token (client/tenant/
	 *  cloud/secret). Compared at refresh time to detect a mid-session config edit. */
	protected abstract configFingerprint(): string;

	/** Subclasses supply the provider hooks; the base runs the shared flow. */
	protected abstract signInFlow(): SignInFlow;

	/**
	 * Run the interactive loopback sign-in. Never rejects — the outcome is reported
	 * via AuthState (see `runSignInFlow`). Re-entrant: a call while one is in flight
	 * returns the in-flight promise (finding 3).
	 */
	startSignIn(): Promise<void> {
		if (this.signInPromise) return this.signInPromise;
		this.signInPromise = this.runSignInFlow().finally(() => {
			this.signInPromise = null;
		});
		return this.signInPromise;
	}

	private async runSignInFlow(): Promise<void> {
		const flow = this.signInFlow();
		const configError = flow.validateConfig();
		if (configError) {
			this.setState({status: "error", message: configError});
			return;
		}

		// Generate PKCE challenge and CSRF state.
		const codeVerifier = randomBytes(32).toString("base64url");
		const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
		const oauthState = randomBytes(16).toString("base64url");
		const epoch = this.sessionEpoch;

		try {
			const {port, code: codePromise} = await this.loopback.start(oauthState);
			const redirectUri = flow.redirectUri(port);
			const authUrl = flow.buildAuthUrl(redirectUri, codeChallenge, oauthState);

			this.setState({status: "signing-in", message: "Complete sign-in in your browser…"});

			// Open the browser using Electron shell.
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
				const electron = require("electron") as {shell: {openExternal(url: string): Promise<void>}};
				void electron.shell.openExternal(authUrl);
			} catch {
				// No browser to complete in: keep a live session (finding 8), else error.
				this.setState(this.tokenCache
					? this.stateFromCache()
					: {status: "error", message: "Failed to open browser — Electron not available"});
				return;
			}

			// Wait for the auth code from the redirect.
			const authCode = await codePromise;
			if (!authCode) {
				// A cancelled/timed-out re-auth must not clobber a live session: if a
				// token is still cached, restore signed-in (finding 8). Only surface a
				// terminal error/signed-out state when there is no session to preserve.
				if (this.tokenCache) {
					this.setState(this.stateFromCache());
				} else if (this.loopback.timedOut) {
					const mins = Math.round(LoopbackOAuthServer.TIMEOUT_MS / 60000);
					this.setState({
						status: "error",
						message: `Sign-in timed out after ${mins} minutes — please try again.`,
					});
				} else {
					this.setState({status: "signed-out"});
				}
				return;
			}

			const cache = await flow.exchangeCode(authCode, codeVerifier, redirectUri);
			// Signed out (or the session was replaced) while the exchange was in
			// flight — the user discarded this sign-in, so drop its token.
			if (epoch !== this.sessionEpoch) return;
			this.invalidateInFlight();
			await this.saveToken(cache);
			this.setState({status: "signed-in"});
		} catch (e) {
			if (epoch !== this.sessionEpoch) return;
			// A failed authorization-code exchange does not invalidate an existing
			// refresh token, so a failed re-auth over a live session restores
			// signed-in (findings 5 & 8). Only a fresh sign-in surfaces the error —
			// carrying the machine-readable code for api.startSignIn to classify.
			if (this.tokenCache) {
				this.setState(this.stateFromCache());
			} else if (e instanceof AuthError) {
				this.setState({status: "error", message: e.message, code: e.code});
			} else {
				const message = e instanceof Error ? e.message : "Authentication failed.";
				this.setState({status: "error", message});
			}
		} finally {
			this.loopback.stop();
		}
	}

	/**
	 * Shared OAuth token endpoint call for both the code exchange and the refresh.
	 * Owns requestUrl + NETWORK/AUTH_FAILED classification (C1): only an explicit
	 * OAuth error body is AUTH_FAILED (grant bad). A transport rejection, 5xx,
	 * throttling (408/429), or a 4xx with no OAuth error (proxy / captive-portal
	 * HTML) is NETWORK (transient — keep the grant). Returns a response
	 * guaranteed to carry both `access_token` and `expires_in`.
	 */
	protected async postTokenRequest(url: string, body: Record<string, string>): Promise<TokenResponse> {
		let response;
		try {
			// throw:false so a 4xx OAuth error resolves (classified below) instead of
			// throwing a generic error; a genuine transport failure still rejects.
			response = await requestUrl({
				url,
				method: "POST",
				headers: {"Content-Type": "application/x-www-form-urlencoded"},
				throw: false,
				body: new URLSearchParams(body).toString(),
			});
		} catch (e) {
			// Offline / DNS / VPN flap — transient. Keep the refresh token (NETWORK).
			throw new AuthError(`Network error contacting token endpoint: ${e instanceof Error ? e.message : String(e)}`, "NETWORK");
		}

		let token: TokenResponse | undefined;
		try { token = response.json as TokenResponse; } catch { token = undefined; }

		// Only an explicit OAuth error body means the grant/request is actually bad.
		// Throttling and timeouts are transient whatever the body says.
		const throttled = response.status === 408 || response.status === 429;
		if (token?.error && !throttled && response.status < 500) {
			throw new AuthError(token.error_description ?? token.error, "AUTH_FAILED");
		}
		// Any other error status, missing access token, or missing expiry —
		// transient, not a credential failure. Guarding expires_in here keeps
		// expiresAt from becoming NaN, which would force a refresh on every
		// subsequent getAccessToken (C1).
		if (response.status >= 400 || !token?.access_token || token.expires_in === undefined) {
			throw new AuthError(`Token request returned no usable token (HTTP ${response.status})`, "NETWORK");
		}

		return token;
	}

	/** Subclasses implement the provider-specific token refresh. */
	protected abstract doRefreshToken(refreshToken: string): Promise<TokenCache>;

	private async refreshAccessToken(): Promise<string> {
		// Deduplicate concurrent refresh calls — if a refresh is already in-flight,
		// return the same promise to avoid rotating the refresh token multiple times.
		if (this.refreshPromise) return this.refreshPromise;
		const refresh = this.doRefresh();
		this.refreshPromise = refresh;
		try {
			return await refresh;
		} finally {
			if (this.refreshPromise === refresh) this.refreshPromise = null;
		}
	}

	private async doRefresh(): Promise<string> {
		if (!this.tokenCache?.refreshToken) {
			await this.signOut();
			throw new AuthError("No refresh token. Please sign in again.", "NOT_AUTHENTICATED");
		}

		const epoch = this.sessionEpoch;
		const stale = () => new AuthError("Session changed during token refresh.", "NOT_AUTHENTICATED");
		try {
			const newCache = await this.doRefreshToken(this.tokenCache.refreshToken);
			// Signed out (or the session was replaced) while the refresh was in
			// flight — writing the token back would undo that.
			if (epoch !== this.sessionEpoch) throw stale();
			const recovered = this.configMismatch;
			await this.saveToken(newCache);
			if (recovered) this.setState(this.stateFromCache());
			return newCache.accessToken;
		} catch (e) {
			// A stale refresh must not sign out the session that replaced it either.
			if (epoch !== this.sessionEpoch) throw stale();
			if (e instanceof AuthError) {
				// A NETWORK failure is transient — leave the cached refresh token intact
				// so the next attempt (once connectivity returns) can succeed. Signing
				// out here would persist a null cache and force a full browser re-auth
				// for a passing Wi-Fi/VPN hiccup.
				if (e.code === "NETWORK") throw e;
				// AUTH_FAILED normally means the grant is dead (signed out below). But if
				// the identity config was edited since this token was minted, the 4xx is
				// far more likely the half-typed config than a revoked grant — reclassify
				// as transient so the valid refresh token survives the edit (finding 1),
				// and surface an error state so the user is prompted to re-authenticate.
				if (e.code === "AUTH_FAILED" && this.configChangedSinceMint()) {
					if (!this.configMismatch) {
						this.configMismatch = true;
						this.setState(this.stateFromCache());
					}
					throw new AuthError(
						"Provider configuration changed since sign-in — not signing out. Re-check settings and retry.",
						"NETWORK",
					);
				}
				// AUTH_FAILED: the grant is dead — sign out so state is consistent and
				// the UI re-renders a signed-out banner instead of a stuck session.
				if (e.code === "AUTH_FAILED") {
					try { await this.signOut(); } catch { /* best effort */ }
				}
				throw e;
			}
			await this.signOut();
			throw new AuthError("Session expired. Please sign in again.", "NOT_AUTHENTICATED");
		}
	}

	private configChangedSinceMint(): boolean {
		return this.tokenConfigFingerprint !== null
			&& this.tokenConfigFingerprint !== this.configFingerprint();
	}
}
