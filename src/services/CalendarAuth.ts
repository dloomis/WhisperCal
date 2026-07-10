import type {AuthState} from "./AuthTypes";

/**
 * Provider-agnostic authentication interface.
 * Both MsalAuth (Microsoft) and GoogleAuth implement this contract.
 */
export interface CalendarAuth {
	initialize(): void;
	startSignIn(): Promise<void>;
	cancelSignIn(): void;
	signOut(): Promise<void>;
	getAccessToken(): Promise<string>;
	isSignedIn(): boolean;
	getState(): AuthState;
	updateConfig(config: Record<string, string>): void;
}

export class AuthError extends Error {
	// NETWORK marks a transient transport failure (offline, DNS, VPN flap): the
	// refresh token is still valid, so the caller must NOT sign the user out.
	code: "NOT_AUTHENTICATED" | "AUTH_FAILED" | "NETWORK";

	constructor(message: string, code: "NOT_AUTHENTICATED" | "AUTH_FAILED" | "NETWORK") {
		super(message);
		this.name = "AuthError";
		this.code = code;
	}
}
