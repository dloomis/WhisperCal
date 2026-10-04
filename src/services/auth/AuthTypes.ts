export interface TokenCache {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // Unix ms
}

export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
	error?: string;
	error_description?: string;
}

/** Machine-readable failure classes shared by AuthError and the error AuthState. */
export type AuthErrorCode = "NOT_AUTHENTICATED" | "AUTH_FAILED" | "NETWORK";

export type AuthState =
	| { status: "signed-out" }
	| { status: "signing-in"; message?: string }
	| { status: "signed-in" }
	// `code` carries the machine-readable failure class so consumers need not
	// sniff the free-text message. Optional: config/UI errors carry no code.
	| { status: "error"; message: string; code?: AuthErrorCode };

export type CloudInstance = "Public" | "USGov" | "USGovHigh" | "USGovDoD" | "China";

export interface CloudEndpoints {
	authority: string;
	graphBaseUrl: string;
}

export const CLOUD_ENDPOINTS: Record<CloudInstance, CloudEndpoints> = {
	Public: {
		authority: "https://login.microsoftonline.com",
		graphBaseUrl: "https://graph.microsoft.com",
	},
	USGov: {
		authority: "https://login.microsoftonline.com",
		graphBaseUrl: "https://graph.microsoft.com",
	},
	USGovHigh: {
		authority: "https://login.microsoftonline.us",
		graphBaseUrl: "https://graph.microsoft.us",
	},
	USGovDoD: {
		authority: "https://login.microsoftonline.us",
		graphBaseUrl: "https://dod-graph.microsoft.us",
	},
	China: {
		authority: "https://login.chinacloudapi.cn",
		graphBaseUrl: "https://microsoftgraph.chinacloudapi.cn",
	},
};

export const CLOUD_INSTANCE_OPTIONS: CloudInstance[] = [
	"Public",
	"USGov",
	"USGovHigh",
	"USGovDoD",
	"China",
];
