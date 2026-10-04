import type {AuthState, AuthErrorCode} from "./auth/AuthTypes";

export type {AuthState} from "./auth/AuthTypes";

/**
 * Provider-agnostic authentication interface, implemented by MsalAuth
 * (Microsoft) and GoogleAuth. GraphApiProvider / GoogleCalendarProvider / the
 * people-search providers depend only on this contract.
 */
export interface CalendarAuth {
	initialize(): void;
	startSignIn(): Promise<void>;
	cancelSignIn(): void;
	signOut(): Promise<void>;
	getAccessToken(): Promise<string>;
	isSignedIn(): boolean;
	getState(): AuthState;
	/** Microsoft Graph base URL for the configured cloud (GCC High aware).
	 *  Google implementations return "" — their providers never call it. */
	getGraphBaseUrl(): string;
	updateConfig(config: Record<string, string>): void;
}

export class AuthError extends Error {
	// NETWORK marks a transient transport failure (offline, DNS, VPN flap): the
	// refresh token is still valid, so the caller must NOT sign the user out.
	code: AuthErrorCode;

	constructor(message: string, code: AuthErrorCode) {
		super(message);
		this.name = "AuthError";
		this.code = code;
	}
}
