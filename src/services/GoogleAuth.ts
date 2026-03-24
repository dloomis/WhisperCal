import {requestUrl} from "obsidian";
import {createServer, type Server} from "http";
import {createHash, randomBytes} from "crypto";
import type {TokenCache, AuthState} from "./AuthTypes";
import type {CalendarAuth} from "./CalendarAuth";
import {AuthError} from "./CalendarAuth";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
	"https://www.googleapis.com/auth/calendar.readonly",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/contacts.readonly",
].join(" ");

export interface GoogleAuthConfig {
	clientId: string;
	clientSecret: string;
}

export interface GoogleAuthCallbacks {
	loadTokenCache(): TokenCache | null;
	saveTokenCache(cache: TokenCache | null): Promise<void>;
	onStateChange(state: AuthState): void;
}

export class GoogleAuth implements CalendarAuth {
	private config: GoogleAuthConfig;
	private callbacks: GoogleAuthCallbacks;
	private tokenCache: TokenCache | null = null;
	private server: Server | null = null;
	private state: AuthState = {status: "signed-out"};

	constructor(config: GoogleAuthConfig, callbacks: GoogleAuthCallbacks) {
		this.config = config;
		this.callbacks = callbacks;
	}

	initialize(): void {
		this.tokenCache = this.callbacks.loadTokenCache();
		if (this.tokenCache) {
			this.setState({status: "signed-in"});
		} else {
			this.setState({status: "signed-out"});
		}
	}

	updateConfig(config: GoogleAuthConfig): void {
		this.config = config;
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

		if (Date.now() < this.tokenCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
			return this.tokenCache.accessToken;
		}

		return this.refreshAccessToken();
	}

	async startSignIn(): Promise<void> {
		const {clientId, clientSecret} = this.config;
		if (!clientId || !clientSecret) {
			this.setState({status: "error", message: "Client ID and Client secret are required."});
			return;
		}

		// Generate PKCE challenge
		const codeVerifier = randomBytes(32).toString("base64url");
		const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

		try {
			// Start loopback server on random port
			const {port, code: codePromise} = await this.startLoopbackServer();
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
			});
			const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

			this.setState({status: "signing-in", message: "Complete sign-in in your browser\u2026"});

			// Open the browser using Electron shell (electron is external at bundle time)
			// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
			const electron = require("electron") as {shell: {openExternal(url: string): Promise<void>}};
			void electron.shell.openExternal(authUrl);

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

			this.tokenCache = {
				accessToken: token.access_token,
				refreshToken: token.refresh_token ?? "",
				expiresAt: Date.now() + token.expires_in * 1000,
			};
			await this.callbacks.saveTokenCache(this.tokenCache);
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

	async signOut(): Promise<void> {
		this.cancelSignIn();
		this.tokenCache = null;
		await this.callbacks.saveTokenCache(null);
		this.setState({status: "signed-out"});
	}

	private async refreshAccessToken(): Promise<string> {
		if (!this.tokenCache?.refreshToken) {
			await this.signOut();
			throw new AuthError("No refresh token. Please sign in again.", "NOT_AUTHENTICATED");
		}

		const {clientId, clientSecret} = this.config;

		try {
			const response = await requestUrl({
				url: GOOGLE_TOKEN_URL,
				method: "POST",
				headers: {"Content-Type": "application/x-www-form-urlencoded"},
				body: new URLSearchParams({
					grant_type: "refresh_token",
					client_id: clientId,
					client_secret: clientSecret,
					refresh_token: this.tokenCache.refreshToken,
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

			this.tokenCache = {
				accessToken: token.access_token,
				refreshToken: this.tokenCache.refreshToken, // Google doesn't return new refresh token
				expiresAt: Date.now() + token.expires_in * 1000,
			};
			await this.callbacks.saveTokenCache(this.tokenCache);
			return this.tokenCache.accessToken;
		} catch (e) {
			if (e instanceof AuthError) throw e;
			await this.signOut();
			throw new AuthError("Session expired. Please sign in again.", "NOT_AUTHENTICATED");
		}
	}

	private startLoopbackServer(): Promise<{port: number; code: Promise<string | null>}> {
		return new Promise((resolveStart, rejectStart) => {
			let resolveCode: (code: string | null) => void;
			const codePromise = new Promise<string | null>((r) => { resolveCode = r; });

			const server = createServer((req, res) => {
				const url = new URL(req.url ?? "", `http://127.0.0.1`);
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				if (code) {
					res.writeHead(200, {"Content-Type": "text/html"});
					res.end("<html><body><h2>Sign-in complete</h2><p>You can close this tab and return to Obsidian.</p></body></html>");
					resolveCode(code);
				} else {
					const msg = error ?? "No authorization code received.";
					res.writeHead(400, {"Content-Type": "text/html"});
					res.end(`<html><body><h2>Sign-in failed</h2><p>${msg}</p></body></html>`);
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
				resolveStart({port: addr.port, code: codePromise});
			});
		});
	}

	private stopLoopbackServer(): void {
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}

	private setState(state: AuthState): void {
		this.state = state;
		this.callbacks.onStateChange(state);
	}
}
