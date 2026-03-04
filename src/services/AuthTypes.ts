export interface TokenCache {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // Unix ms
}

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
	message: string;
}

export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
	error?: string;
	error_description?: string;
}

export type AuthState =
	| { status: "signed-out" }
	| { status: "signing-in"; userCode: string; verificationUri: string }
	| { status: "signed-in" }
	| { status: "error"; message: string };

export type CloudInstance = "Public" | "USGov" | "USGovHigh" | "USGovDoD" | "China";

export interface CloudEndpoints {
	authority: string;
	graphBaseUrl: string;
	deviceLoginUrl: string;
}

export const CLOUD_ENDPOINTS: Record<CloudInstance, CloudEndpoints> = {
	Public: {
		authority: "https://login.microsoftonline.com",
		graphBaseUrl: "https://graph.microsoft.com",
		deviceLoginUrl: "https://microsoft.com/devicelogin",
	},
	USGov: {
		authority: "https://login.microsoftonline.com",
		graphBaseUrl: "https://graph.microsoft.com",
		deviceLoginUrl: "https://microsoft.com/deviceloginus",
	},
	USGovHigh: {
		authority: "https://login.microsoftonline.us",
		graphBaseUrl: "https://graph.microsoft.us",
		deviceLoginUrl: "https://microsoft.com/deviceloginus",
	},
	USGovDoD: {
		authority: "https://login.microsoftonline.us",
		graphBaseUrl: "https://dod-graph.microsoft.us",
		deviceLoginUrl: "https://microsoft.com/deviceloginus",
	},
	China: {
		authority: "https://login.chinacloudapi.cn",
		graphBaseUrl: "https://microsoftgraph.chinacloudapi.cn",
		deviceLoginUrl: "https://login.chinacloudapi.cn/common/oauth2/deviceauth",
	},
};

export const CLOUD_INSTANCE_OPTIONS: CloudInstance[] = [
	"Public",
	"USGov",
	"USGovHigh",
	"USGovDoD",
	"China",
];
