import {requestUrl, type RequestUrlResponse} from "obsidian";
import {createHash, randomBytes} from "crypto";
import type {TokenCache} from "./AuthTypes";
import {AuthError} from "./CalendarAuth";
import {BaseCalendarAuth, type AuthCallbacks} from "./BaseCalendarAuth";
import {LoopbackOAuthServer} from "./LoopbackOAuthServer";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
	"https://www.googleapis.com/auth/calendar.readonly",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/contacts.readonly",
].join(" ");

interface GoogleAuthConfig {
	clientId: string;
	clientSecret: string;
}

export class GoogleAuth extends BaseCalendarAuth {
	private config: GoogleAuthConfig;
	private readonly loopback = new LoopbackOAuthServer();

	constructor(config: GoogleAuthConfig, callbacks: AuthCallbacks) {
		super(callbacks);
		this.config = config;
	}

	updateConfig(config: Record<string, string>): void {
		this.config = {
			clientId: config["clientId"] ?? "",
			clientSecret: config["clientSecret"] ?? "",
		};
	}

	async startSignIn(): Promise<void> {
		const {clientId, clientSecret} = this.config;
		if (!clientId || !clientSecret) {
			this.setState({status: "error", message: "Client ID and Client secret are required."});
			return;
		}

		// Generate PKCE challenge and CSRF state
		const codeVerifier = randomBytes(32).toString("base64url");
		const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
		const oauthState = randomBytes(16).toString("base64url");

		try {
			// Start loopback server on random port
			const {port, code: codePromise} = await this.loopback.start(oauthState);
			const redirectUri = `http://127.0.0.1:${port}`;

			// Build auth URL and open in browser
			const params = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirectUri,
				response_type: "code",
				scope: SCOPES,
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
				access_type: "offline",
				prompt: "consent",
				state: oauthState,
			});
			const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

			this.setState({status: "signing-in", message: "Complete sign-in in your browser\u2026"});

			// Open the browser using Electron shell
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
				const electron = require("electron") as {shell: {openExternal(url: string): Promise<void>}};
				void electron.shell.openExternal(authUrl);
			} catch {
				this.setState({status: "error", message: "Failed to open browser — Electron not available"});
				return;
			}

			// Wait for the auth code from the redirect
			const authCode = await codePromise;
			if (!authCode) {
				if (this.loopback.timedOut) {
					const mins = Math.round(LoopbackOAuthServer.TIMEOUT_MS / 60000);
					this.setState({
						status: "error",
						message: `Sign-in timed out after ${mins} minutes — please try again.`,
					});
				} else {
					// Cancelled
					this.setState({status: "signed-out"});
				}
				return;
			}

			// Exchange code for tokens
			const response = await requestUrl({
				url: GOOGLE_TOKEN_URL,
				method: "POST",
				headers: {"Content-Type": "application/x-www-form-urlencoded"},
				body: new URLSearchParams({
					code: authCode,
					client_id: clientId,
					client_secret: clientSecret,
					redirect_uri: redirectUri,
					grant_type: "authorization_code",
					code_verifier: codeVerifier,
				}).toString(),
			});

			const token = response.json as {
				access_token: string;
				refresh_token?: string;
				expires_in: number;
				error?: string;
				error_description?: string;
			};

			if (token.error) {
				throw new AuthError(token.error_description ?? token.error, "AUTH_FAILED");
			}
			if (!token.refresh_token) {
				throw new AuthError(
					"Google did not return a refresh token. Revoke app access at myaccount.google.com/permissions, then sign in again.",
					"AUTH_FAILED",
				);
			}

			await this.saveToken({
				accessToken: token.access_token,
				refreshToken: token.refresh_token,
				expiresAt: Date.now() + token.expires_in * 1000,
			});
			this.setState({status: "signed-in"});
		} catch (e) {
			if (e instanceof AuthError) {
				this.setState({status: "error", message: e.message});
			} else {
				const message = e instanceof Error ? e.message : "Authentication failed.";
				this.setState({status: "error", message});
			}
		} finally {
			this.loopback.stop();
		}
	}

	cancelSignIn(): void {
		this.loopback.stop();
	}

	protected async doRefreshToken(refreshToken: string): Promise<TokenCache> {
		const {clientId, clientSecret} = this.config;

		type GoogleTokenResponse = {
			access_token?: string;
			expires_in?: number;
			error?: string;
			error_description?: string;
		};

		let response: RequestUrlResponse;
		try {
			// throw:false so a 4xx OAuth error resolves (we classify it below) instead
			// of throwing a generic error; a genuine transport failure still rejects.
			response = await requestUrl({
				url: GOOGLE_TOKEN_URL,
				method: "POST",
				headers: {"Content-Type": "application/x-www-form-urlencoded"},
				throw: false,
				body: new URLSearchParams({
					grant_type: "refresh_token",
					client_id: clientId,
					client_secret: clientSecret,
					refresh_token: refreshToken,
				}).toString(),
			});
		} catch (e) {
			// Offline / DNS / VPN flap — transient. Keep the refresh token (NETWORK).
			throw new AuthError(`Network error refreshing token: ${e instanceof Error ? e.message : String(e)}`, "NETWORK");
		}

		let token: GoogleTokenResponse | undefined;
		try { token = response.json as GoogleTokenResponse; } catch { token = undefined; }

		// Explicit OAuth error body or a 4xx means the grant is actually bad.
		if (token?.error || (response.status >= 400 && response.status < 500)) {
			throw new AuthError(token?.error_description ?? token?.error ?? `Token refresh failed (HTTP ${response.status})`, "AUTH_FAILED");
		}
		// 5xx or a missing access token — treat as transient, not a credential failure.
		if (!token?.access_token || token.expires_in === undefined) {
			throw new AuthError(`Token refresh returned no access token (HTTP ${response.status})`, "NETWORK");
		}

		return {
			accessToken: token.access_token,
			refreshToken, // Google doesn't return new refresh token
			expiresAt: Date.now() + token.expires_in * 1000,
		};
	}
}
