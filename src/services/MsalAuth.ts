import {requestUrl} from "obsidian";
import {createServer, type Server} from "http";
import {createHash, randomBytes} from "crypto";
import type {
	TokenCache,
	TokenResponse,
	CloudInstance,
} from "./AuthTypes";
import {CLOUD_ENDPOINTS} from "./AuthTypes";
import {AuthError} from "./CalendarAuth";
import {BaseCalendarAuth, type AuthCallbacks} from "./BaseCalendarAuth";

interface MsalAuthConfig {
	tenantId: string;
	clientId: string;
	cloudInstance: CloudInstance;
}

const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class MsalAuth extends BaseCalendarAuth {
	private config: MsalAuthConfig;
	private server: Server | null = null;
	private loopbackTimer: ReturnType<typeof setTimeout> | null = null;

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
		const {tenantId, clientId, cloudInstance} = this.config;
		if (!tenantId || !clientId) {
			this.setState({status: "error", message: "Tenant ID and Client ID are required."});
			return;
		}

		// Generate PKCE challenge and CSRF state
		const codeVerifier = randomBytes(32).toString("base64url");
		const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
		const oauthState = randomBytes(16).toString("base64url");
		const endpoints = CLOUD_ENDPOINTS[cloudInstance];

		try {
			// Start loopback server on random port
			const {port, code: codePromise} = await this.startLoopbackServer(oauthState);
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
				// Cancelled or timed out
				this.setState({status: "signed-out"});
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
			this.stopLoopbackServer();
		}
	}

	cancelSignIn(): void {
		this.stopLoopbackServer();
	}

	protected async doRefreshToken(refreshToken: string): Promise<TokenCache> {
		const {tenantId, clientId, cloudInstance} = this.config;
		const endpoints = CLOUD_ENDPOINTS[cloudInstance];
		const tokenUrl = `${endpoints.authority}/${tenantId}/oauth2/v2.0/token`;

		const response = await requestUrl({
			url: tokenUrl,
			method: "POST",
			headers: {"Content-Type": "application/x-www-form-urlencoded"},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: clientId,
				refresh_token: refreshToken,
				scope: this.getScopes(),
			}).toString(),
		});

		const token = response.json as TokenResponse;
		if (token.error) {
			throw new AuthError(
				token.error_description ?? token.error,
				"AUTH_FAILED"
			);
		}

		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token ?? refreshToken,
			expiresAt: Date.now() + token.expires_in * 1000,
		};
	}

	private startLoopbackServer(expectedState: string): Promise<{port: number; code: Promise<string | null>}> {
		return new Promise((resolveStart, rejectStart) => {
			let resolveCode: (code: string | null) => void;
			const codePromise = new Promise<string | null>((r) => { resolveCode = r; });

			const server = createServer((req, res) => {
				const url = new URL(req.url ?? "", "http://127.0.0.1");
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");
				const state = url.searchParams.get("state");

				if (state !== expectedState) {
					res.writeHead(400, {"Content-Type": "text/plain"});
					res.end("Sign-in failed: invalid state parameter");
					return;
				}

				if (code) {
					res.writeHead(200, {"Content-Type": "text/html"});
					res.end("<html><body><h2>Sign-in complete</h2><p>You can close this tab and return to Obsidian.</p></body></html>");
					resolveCode(code);
				} else {
					const msg = error ?? "No authorization code received.";
					res.writeHead(400, {"Content-Type": "text/plain"});
					res.end(`Sign-in failed: ${msg}`);
					resolveCode(null);
				}
			});

			server.on("error", (e) => {
				rejectStart(e);
			});

			// Listen on random port on loopback
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (!addr || typeof addr === "string") {
					rejectStart(new Error("Failed to start loopback server"));
					return;
				}
				this.server = server;
				// Time out after 5 minutes if the user doesn't complete the flow
				this.loopbackTimer = setTimeout(() => {
					resolveCode(null);
					this.stopLoopbackServer();
				}, LOOPBACK_TIMEOUT_MS);
				resolveStart({port: addr.port, code: codePromise});
			});
		});
	}

	private stopLoopbackServer(): void {
		if (this.loopbackTimer) {
			clearTimeout(this.loopbackTimer);
			this.loopbackTimer = null;
		}
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}
}
