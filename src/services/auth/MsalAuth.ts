import type {
	TokenCache,
	CloudInstance,
} from "./AuthTypes";
import {CLOUD_ENDPOINTS} from "./AuthTypes";
import {AuthError} from "../CalendarAuth";
import {BaseCalendarAuth, type SignInFlow} from "./BaseCalendarAuth";

export interface MsalAuthConfig {
	tenantId: string;
	clientId: string;
	cloudInstance: CloudInstance;
}

export class MsalAuth extends BaseCalendarAuth<MsalAuthConfig> {
	getGraphBaseUrl(): string {
		return this.endpoints().graphBaseUrl;
	}

	protected configFingerprint(): string {
		const {tenantId, clientId, cloudInstance} = this.config;
		return `${tenantId}|${clientId}|${cloudInstance}`;
	}

	/** Endpoints for the configured cloud, defaulting to Public if the value is
	 *  somehow out of range (defensive — loadSettings validates). */
	private endpoints() {
		return CLOUD_ENDPOINTS[this.config.cloudInstance] ?? CLOUD_ENDPOINTS.Public;
	}

	/**
	 * Build fully-qualified scope string for the current cloud instance.
	 *
	 * `Chat.Read` backs WhisperCal's Teams meeting-chat pull (delegated reads of
	 * chats the signed-in user is a member of). Adding a scope invalidates
	 * consent granted for the older, narrower set: the refresh grant fails with
	 * AADSTS65001 until the user signs in again, so a scope change here always
	 * means "everyone re-authenticates once" — and the app registration must
	 * carry the matching delegated permission first.
	 */
	private getScopes(): string {
		const graphBaseUrl = this.endpoints().graphBaseUrl;
		return [
			`${graphBaseUrl}/Calendars.Read`,
			`${graphBaseUrl}/People.Read`,
			`${graphBaseUrl}/User.ReadBasic.All`,
			`${graphBaseUrl}/Chat.Read`,
			"offline_access",
		].join(" ");
	}

	private tokenUrl(): string {
		const tenantId = this.config.tenantId || "organizations";
		return `${this.endpoints().authority}/${tenantId}/oauth2/v2.0/token`;
	}

	protected signInFlow(): SignInFlow {
		return {
			validateConfig: () =>
				this.config.clientId ? null : "Client ID is required.",
			// Microsoft: the Azure app registration has http://localhost registered
			// (port ignored for loopback), so advertise `localhost` here to match it.
			// The loopback server binds 127.0.0.1; localhost resolves to 127.0.0.1
			// first on IPv4-stack systems, so the redirect still reaches it.
			redirectUri: (port) => `http://localhost:${port}`,
			buildAuthUrl: (redirectUri, codeChallenge, state) => {
				const tenantId = this.config.tenantId || "organizations";
				const params = new URLSearchParams({
					client_id: this.config.clientId,
					response_type: "code",
					redirect_uri: redirectUri,
					scope: this.getScopes(),
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
					state,
					prompt: "select_account",
				});
				return `${this.endpoints().authority}/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
			},
			exchangeCode: async (code, codeVerifier, redirectUri) => {
				const token = await this.postTokenRequest(this.tokenUrl(), {
					grant_type: "authorization_code",
					client_id: this.config.clientId,
					code,
					redirect_uri: redirectUri,
					code_verifier: codeVerifier,
				});
				if (!token.refresh_token) {
					throw new AuthError(
						"Microsoft did not return a refresh token. Your tenant may require admin consent for offline_access.",
						"AUTH_FAILED",
					);
				}
				return {
					accessToken: token.access_token,
					refreshToken: token.refresh_token,
					expiresAt: Date.now() + token.expires_in * 1000,
				};
			},
		};
	}

	protected async doRefreshToken(refreshToken: string): Promise<TokenCache> {
		const token = await this.postTokenRequest(this.tokenUrl(), {
			grant_type: "refresh_token",
			client_id: this.config.clientId,
			refresh_token: refreshToken,
			scope: this.getScopes(),
		});
		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token ?? refreshToken,
			expiresAt: Date.now() + token.expires_in * 1000,
		};
	}
}
