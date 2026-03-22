import {requestUrl} from "obsidian";
import type {
	TokenCache,
	DeviceCodeResponse,
	TokenResponse,
	AuthState,
	CloudInstance,
} from "./AuthTypes";
import {CLOUD_ENDPOINTS} from "./AuthTypes";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min early
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface MsalAuthConfig {
	tenantId: string;
	clientId: string;
	cloudInstance: CloudInstance;
	deviceLoginUrl?: string;
}

export interface MsalAuthCallbacks {
	loadTokenCache(): TokenCache | null;
	saveTokenCache(cache: TokenCache | null): Promise<void>;
	onStateChange(state: AuthState): void;
}

export class MsalAuth {
	private config: MsalAuthConfig;
	private callbacks: MsalAuthCallbacks;
	private tokenCache: TokenCache | null = null;
	private abortController: AbortController | null = null;
	private state: AuthState = {status: "signed-out"};

	constructor(config: MsalAuthConfig, callbacks: MsalAuthCallbacks) {
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

	updateConfig(config: MsalAuthConfig): void {
		this.config = config;
	}

	getState(): AuthState {
		return this.state;
	}

	isSignedIn(): boolean {
		return this.tokenCache !== null;
	}

	getGraphBaseUrl(): string {
		return CLOUD_ENDPOINTS[this.config.cloudInstance].graphBaseUrl;
	}

	/** Build fully-qualified scope string for the current cloud instance. */
	private getScopes(): string {
		const graphBaseUrl = CLOUD_ENDPOINTS[this.config.cloudInstance].graphBaseUrl;
		return `${graphBaseUrl}/Calendars.Read ${graphBaseUrl}/People.Read ${graphBaseUrl}/User.ReadBasic.All offline_access`;
	}

	async getAccessToken(): Promise<string> {
		if (!this.tokenCache) {
			throw new AuthError("Not signed in.", "NOT_AUTHENTICATED");
		}

		if (Date.now() < this.tokenCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
			return this.tokenCache.accessToken;
		}

		// Token expired or near expiry — refresh
		return this.refreshAccessToken();
	}

	async startDeviceCodeFlow(): Promise<void> {
		const {tenantId, clientId, cloudInstance} = this.config;
		if (!tenantId || !clientId) {
			this.setState({status: "error", message: "Tenant ID and Client ID are required."});
			return;
		}

		this.abortController = new AbortController();
		const endpoints = CLOUD_ENDPOINTS[cloudInstance];

		try {
			// Step 1: Request device code
			const scopes = this.getScopes();
			const deviceCodeUrl = `${endpoints.authority}/${tenantId}/oauth2/v2.0/devicecode`;
			const dcResponse = await requestUrl({
				url: deviceCodeUrl,
				method: "POST",
				headers: {"Content-Type": "application/x-www-form-urlencoded"},
				body: new URLSearchParams({client_id: clientId, scope: scopes}).toString(),
			});
			const deviceCode = dcResponse.json as DeviceCodeResponse;

			const loginUrl = this.config.deviceLoginUrl?.trim() || endpoints.deviceLoginUrl;
			this.setState({
				status: "signing-in",
				userCode: deviceCode.user_code,
				verificationUri: loginUrl,
			});

			// Step 2: Poll for token
			const intervalMs = (deviceCode.interval || 5) * 1000;
			const expiresAt = Date.now() + deviceCode.expires_in * 1000;
			const tokenUrl = `${endpoints.authority}/${tenantId}/oauth2/v2.0/token`;

			while (Date.now() < expiresAt) {
				if (this.abortController?.signal.aborted) {
					this.setState({status: "signed-out"});
					return;
				}

				await this.sleep(intervalMs);

				if (this.abortController?.signal.aborted) {
					this.setState({status: "signed-out"});
					return;
				}

				// Use throw:false so we can inspect status codes directly
				// instead of parsing opaque error objects from requestUrl
				const tokenResponse = await requestUrl({
					url: tokenUrl,
					method: "POST",
					headers: {"Content-Type": "application/x-www-form-urlencoded"},
					body: new URLSearchParams({
						grant_type: DEVICE_CODE_GRANT_TYPE,
						client_id: clientId,
						device_code: deviceCode.device_code,
					}).toString(),
					throw: false,
				});

				const token = tokenResponse.json as TokenResponse;

				if (token.error) {
					if (token.error === "authorization_pending") {
						continue;
					}
					if (token.error === "slow_down") {
						await this.sleep(5000);
						continue;
					}
					console.error("[WhisperCal] Token poll error:", tokenResponse.status, token.error, token.error_description);
					throw new AuthError(
						token.error_description ?? token.error,
						"AUTH_FAILED"
					);
				}

				if (tokenResponse.status !== 200) {
					console.error("[WhisperCal] Token poll unexpected status:", tokenResponse.status, tokenResponse.text);
					continue; // retry on unexpected status
				}

				// Success
				this.tokenCache = {
					accessToken: token.access_token,
					refreshToken: token.refresh_token ?? "",
					expiresAt: Date.now() + token.expires_in * 1000,
				};
				await this.callbacks.saveTokenCache(this.tokenCache);
				this.setState({status: "signed-in"});
				return;
			}

			this.setState({status: "error", message: "Device code expired. Please try again."});
		} catch (e) {
			if (this.abortController?.signal.aborted) {
				this.setState({status: "signed-out"});
				return;
			}
			const message = e instanceof Error ? e.message : "Authentication failed.";
			this.setState({status: "error", message});
		} finally {
			this.abortController = null;
		}
	}

	async signOut(): Promise<void> {
		this.cancelSignIn();
		this.tokenCache = null;
		await this.callbacks.saveTokenCache(null);
		this.setState({status: "signed-out"});
	}

	cancelSignIn(): void {
		this.abortController?.abort();
		this.abortController = null;
	}

	private async refreshAccessToken(): Promise<string> {
		if (!this.tokenCache?.refreshToken) {
			await this.signOut();
			throw new AuthError("No refresh token. Please sign in again.", "NOT_AUTHENTICATED");
		}

		const {tenantId, clientId, cloudInstance} = this.config;
		const endpoints = CLOUD_ENDPOINTS[cloudInstance];
		const tokenUrl = `${endpoints.authority}/${tenantId}/oauth2/v2.0/token`;

		try {
			const response = await requestUrl({
				url: tokenUrl,
				method: "POST",
				headers: {"Content-Type": "application/x-www-form-urlencoded"},
				body: new URLSearchParams({
					grant_type: "refresh_token",
					client_id: clientId,
					refresh_token: this.tokenCache.refreshToken,
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

			this.tokenCache = {
				accessToken: token.access_token,
				refreshToken: token.refresh_token ?? this.tokenCache.refreshToken,
				expiresAt: Date.now() + token.expires_in * 1000,
			};
			await this.callbacks.saveTokenCache(this.tokenCache);
			return this.tokenCache.accessToken;
		} catch (e) {
			if (e instanceof AuthError) throw e;
			// Refresh token likely revoked
			await this.signOut();
			throw new AuthError("Session expired. Please sign in again.", "NOT_AUTHENTICATED");
		}
	}

	private setState(state: AuthState): void {
		this.state = state;
		this.callbacks.onStateChange(state);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = window.setTimeout(resolve, ms);
			this.abortController?.signal.addEventListener("abort", () => {
				window.clearTimeout(timer);
				resolve();
			}, {once: true});
		});
	}
}


export class AuthError extends Error {
	code: "NOT_AUTHENTICATED" | "AUTH_FAILED";

	constructor(message: string, code: "NOT_AUTHENTICATED" | "AUTH_FAILED") {
		super(message);
		this.name = "AuthError";
		this.code = code;
	}
}
