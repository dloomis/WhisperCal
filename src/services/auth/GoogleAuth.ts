import type {TokenCache} from "./AuthTypes";
import {AuthError} from "../CalendarAuth";
import {BaseCalendarAuth, type SignInFlow} from "./BaseCalendarAuth";

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

export class GoogleAuth extends BaseCalendarAuth<GoogleAuthConfig> {
	protected configFingerprint(): string {
		return `${this.config.clientId}|${this.config.clientSecret}`;
	}

	protected signInFlow(): SignInFlow {
		return {
			validateConfig: () =>
				this.config.clientId && this.config.clientSecret
					? null
					: "Client ID and Client secret are required.",
			redirectUri: (port) => `http://127.0.0.1:${port}`,
			buildAuthUrl: (redirectUri, codeChallenge, state) => {
				const params = new URLSearchParams({
					client_id: this.config.clientId,
					redirect_uri: redirectUri,
					response_type: "code",
					scope: SCOPES,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
					access_type: "offline",
					prompt: "consent",
					state,
				});
				return `${GOOGLE_AUTH_URL}?${params.toString()}`;
			},
			exchangeCode: async (code, codeVerifier, redirectUri) => {
				const token = await this.postTokenRequest(GOOGLE_TOKEN_URL, {
					code,
					client_id: this.config.clientId,
					client_secret: this.config.clientSecret,
					redirect_uri: redirectUri,
					grant_type: "authorization_code",
					code_verifier: codeVerifier,
				});
				if (!token.refresh_token) {
					throw new AuthError(
						"Google did not return a refresh token. Revoke app access at myaccount.google.com/permissions, then sign in again.",
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
		const token = await this.postTokenRequest(GOOGLE_TOKEN_URL, {
			grant_type: "refresh_token",
			client_id: this.config.clientId,
			client_secret: this.config.clientSecret,
			refresh_token: refreshToken,
		});
		return {
			accessToken: token.access_token,
			refreshToken, // Google doesn't return a new refresh token on refresh.
			expiresAt: Date.now() + token.expires_in * 1000,
		};
	}
}
