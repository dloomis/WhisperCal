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
	code: "NOT_AUTHENTICATED" | "AUTH_FAILED";

	constructor(message: string, code: "NOT_AUTHENTICATED" | "AUTH_FAILED") {
		super(message);
		this.name = "AuthError";
		this.code = code;
	}
}
