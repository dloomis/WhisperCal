/**
 * Auth state consumed by WhisperCal's UI (sidebar banner, settings status).
 * Formerly in AuthTypes.ts; that file's cloud-endpoint/token types moved to
 * WhisperCore in the C3 cutover, but AuthState is a WhisperCal-internal shape
 * (the CalendarAuth contract's state), so it lives with the interface.
 */
export type AuthState =
	| { status: "signed-out" }
	| { status: "signing-in"; message?: string }
	| { status: "signed-in" }
	| { status: "error"; message: string };

/**
 * Provider-agnostic authentication interface. Since the C3 cutover the sole
 * implementation is CoreCalendarAuth, which delegates to the WhisperCore API;
 * GraphApiProvider / GoogleCalendarProvider / the people-search providers still
 * depend only on this contract.
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
