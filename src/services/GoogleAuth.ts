import {requestUrl} from "obsidian";
import {createServer, type Server} from "http";
import {createHash, randomBytes} from "crypto";
import type {TokenCache} from "./AuthTypes";
import {AuthError} from "./CalendarAuth";
import {BaseCalendarAuth, type AuthCallbacks} from "./BaseCalendarAuth";

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

const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class GoogleAuth extends BaseCalendarAuth {
	private config: GoogleAuthConfig;
	private server: Server | null = null;
	private loopbackTimer: ReturnType<typeof setTimeout> | null = null;

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
			const {port, code: codePromise} = await this.startLoopbackServer(oauthState);
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
				// Cancelled
				this.setState({status: "signed-out"});
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
			this.stopLoopbackServer();
		}
	}

	cancelSignIn(): void {
		this.stopLoopbackServer();
	}

	protected async doRefreshToken(refreshToken: string): Promise<TokenCache> {
		const {clientId, clientSecret} = this.config;

		const response = await requestUrl({
			url: GOOGLE_TOKEN_URL,
			method: "POST",
			headers: {"Content-Type": "application/x-www-form-urlencoded"},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
			}).toString(),
		});

		const token = response.json as {
			access_token: string;
			expires_in: number;
			error?: string;
			error_description?: string;
		};

		if (token.error) {
			throw new AuthError(token.error_description ?? token.error, "AUTH_FAILED");
		}

		return {
			accessToken: token.access_token,
			refreshToken, // Google doesn't return new refresh token
			expiresAt: Date.now() + token.expires_in * 1000,
		};
	}

	private startLoopbackServer(expectedState: string): Promise<{port: number; code: Promise<string | null>}> {
		return new Promise((resolveStart, rejectStart) => {
			let resolveCode: (code: string | null) => void;
			const codePromise = new Promise<string | null>((r) => { resolveCode = r; });

			const server = createServer((req, res) => {
				const url = new URL(req.url ?? "", `http://127.0.0.1`);
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
