import {requestUrl} from "obsidian";
import type {
	TokenCache,
	DeviceCodeResponse,
	TokenResponse,
	CloudInstance,
} from "./AuthTypes";
import {CLOUD_ENDPOINTS} from "./AuthTypes";
import {AuthError} from "./CalendarAuth";
import {BaseCalendarAuth, type AuthCallbacks} from "./BaseCalendarAuth";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

interface MsalAuthConfig {
	tenantId: string;
	clientId: string;
	cloudInstance: CloudInstance;
	deviceLoginUrl?: string;
}

export class MsalAuth extends BaseCalendarAuth {
	private config: MsalAuthConfig;
	private abortController: AbortController | null = null;

	constructor(config: MsalAuthConfig, callbacks: AuthCallbacks) {
		super(callbacks);
		this.config = config;
	}

	updateConfig(config: Record<string, string>): void {
		this.config = {
			tenantId: config["tenantId"] ?? "",
			clientId: config["clientId"] ?? "",
			cloudInstance: (config["cloudInstance"] ?? "Public") as CloudInstance,
			deviceLoginUrl: config["deviceLoginUrl"],
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

	cancelSignIn(): void {
		this.abortController?.abort();
		this.abortController = null;
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
