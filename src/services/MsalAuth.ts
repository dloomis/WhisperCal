import {requestUrl, type RequestUrlResponse} from "obsidian";
import {createHash, randomBytes} from "crypto";
import type {
	TokenCache,
	TokenResponse,
	CloudInstance,
} from "./AuthTypes";
import {CLOUD_ENDPOINTS} from "./AuthTypes";
import {AuthError} from "./CalendarAuth";
import {BaseCalendarAuth, type AuthCallbacks} from "./BaseCalendarAuth";
import {LoopbackOAuthServer} from "./LoopbackOAuthServer";

interface MsalAuthConfig {
	tenantId: string;
	clientId: string;
	cloudInstance: CloudInstance;
}

export class MsalAuth extends BaseCalendarAuth {
	private config: MsalAuthConfig;
	private readonly loopback = new LoopbackOAuthServer();

	constructor(config: MsalAuthConfig, callbacks: AuthCallbacks) {
		super(callbacks);
		this.config = config;
	}

	updateConfig(config: Record<string, string>): void {
		this.config = {
			tenantId: config["tenantId"] ?? "",
			clientId: config["clientId"] ?? "",
			cloudInstance: (config["cloudInstance"] ?? "Public") as CloudInstance,
		};
	}

	getGraphBaseUrl(): string {
		return CLOUD_ENDPOINTS[this.config.cloudInstance].graphBaseUrl;
	}

	/** Build fully-qualified scope string for the current cloud instance. */
	private getScopes(): string {
		const graphBaseUrl = CLOUD_ENDPOINTS[this.config.cloudInstance].graphBaseUrl;
		return `${graphBaseUrl}/Calendars.Read ${graphBaseUrl}/People.Read ${graphBaseUrl}/User.ReadBasic.All offline_access`;
	}

	async startSignIn(): Promise<void> {
		const {clientId, cloudInstance} = this.config;
		const tenantId = this.config.tenantId || "organizations";
		if (!clientId) {
			this.setState({status: "error", message: "Client ID is required."});
			return;
		}

		// Generate PKCE challenge and CSRF state
		const codeVerifier = randomBytes(32).toString("base64url");
		const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
		const oauthState = randomBytes(16).toString("base64url");
		const endpoints = CLOUD_ENDPOINTS[cloudInstance];

		try {
			// Start loopback server on random port
			const {port, code: codePromise} = await this.loopback.start(oauthState);
			const redirectUri = `http://localhost:${port}`;

			// Build auth URL and open in browser
			const scopes = this.getScopes();
			const params = new URLSearchParams({
				client_id: clientId,
				response_type: "code",
				redirect_uri: redirectUri,
				scope: scopes,
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
				state: oauthState,
				prompt: "select_account",
			});
			const authUrl = `${endpoints.authority}/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;

			this.setState({status: "signing-in", message: "Complete sign-in in your browser\u2026"});

			// Open the browser using Electron shell
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
				const electron = require("electron") as {shell: {openExternal(url: string): Promise<void>}};
				void electron.shell.openExternal(authUrl);
			} catch {
				this.setState({status: "error", message: "Failed to open browser \u2014 Electron not available"});
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
			const tokenUrl = `${endpoints.authority}/${tenantId}/oauth2/v2.0/token`;
			const response = await requestUrl({
				url: tokenUrl,
				method: "POST",
				headers: {"Content-Type": "application/x-www-form-urlencoded"},
				body: new URLSearchParams({
					grant_type: "authorization_code",
					client_id: clientId,
					code: authCode,
					redirect_uri: redirectUri,
					code_verifier: codeVerifier,
				}).toString(),
			});

			const token = response.json as TokenResponse;

			if (token.error) {
				throw new AuthError(
					token.error_description ?? token.error,
					"AUTH_FAILED",
				);
			}
			if (!token.refresh_token) {
				throw new AuthError(
					"Microsoft did not return a refresh token. Your tenant may require admin consent for offline_access.",
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
		const {clientId, cloudInstance} = this.config;
		const tenantId = this.config.tenantId || "organizations";
		const endpoints = CLOUD_ENDPOINTS[cloudInstance];
		const tokenUrl = `${endpoints.authority}/${tenantId}/oauth2/v2.0/token`;

		let response: RequestUrlResponse;
		try {
			// throw:false so a 4xx OAuth error resolves (we classify it below) instead
			// of throwing a generic error; a genuine transport failure still rejects.
			response = await requestUrl({
				url: tokenUrl,
				method: "POST",
				headers: {"Content-Type": "application/x-www-form-urlencoded"},
				throw: false,
				body: new URLSearchParams({
					grant_type: "refresh_token",
					client_id: clientId,
					refresh_token: refreshToken,
					scope: this.getScopes(),
				}).toString(),
			});
		} catch (e) {
			// Offline / DNS / VPN flap — transient. Keep the refresh token (NETWORK).
			throw new AuthError(`Network error refreshing token: ${e instanceof Error ? e.message : String(e)}`, "NETWORK");
		}

		let token: TokenResponse | undefined;
		try { token = response.json as TokenResponse; } catch { token = undefined; }

		// Explicit OAuth error body or a 4xx means the grant is actually bad.
		if (token?.error || (response.status >= 400 && response.status < 500)) {
			throw new AuthError(token?.error_description ?? token?.error ?? `Token refresh failed (HTTP ${response.status})`, "AUTH_FAILED");
		}
		// 5xx or a missing access token — treat as transient, not a credential failure.
		if (!token?.access_token) {
			throw new AuthError(`Token refresh returned no access token (HTTP ${response.status})`, "NETWORK");
		}

		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token ?? refreshToken,
			expiresAt: Date.now() + token.expires_in * 1000,
		};
	}
}
