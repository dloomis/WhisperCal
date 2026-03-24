import type {CalendarProviderType, CalendarProvider} from "../types";
import type {WhisperCalSettings} from "../settings";
import type {TokenCache, AuthState} from "./AuthTypes";
import type {CalendarAuth} from "./CalendarAuth";
import type {PeopleSearchProvider} from "./PeopleSearchProvider";
import {MsalAuth} from "./MsalAuth";
import {GraphApiProvider} from "./GraphApiProvider";
import {GraphPeopleSearch} from "./GraphPeopleSearch";
import {GoogleAuth} from "./GoogleAuth";
import {GoogleCalendarProvider} from "./GoogleCalendarProvider";
import {GooglePeopleSearch} from "./GooglePeopleSearch";

export interface AuthCallbacks {
	loadTokenCache(): TokenCache | null;
	saveTokenCache(cache: TokenCache | null): Promise<void>;
	onStateChange(state: AuthState): void;
}

export interface CalendarStack {
	auth: CalendarAuth;
	provider: CalendarProvider;
	peopleSearch: PeopleSearchProvider;
}

export function createCalendarStack(
	type: CalendarProviderType,
	settings: WhisperCalSettings,
	callbacks: AuthCallbacks,
): CalendarStack {
	switch (type) {
	case "microsoft": {
		const auth = new MsalAuth(
			{
				tenantId: settings.tenantId,
				clientId: settings.clientId,
				cloudInstance: settings.cloudInstance,
				deviceLoginUrl: settings.deviceLoginUrl,
			},
			callbacks,
		);
		const provider = new GraphApiProvider(auth);
		const peopleSearch = new GraphPeopleSearch(auth);
		return {auth, provider, peopleSearch};
	}
	case "google": {
		const auth = new GoogleAuth(
			{
				clientId: settings.googleClientId,
				clientSecret: settings.googleClientSecret,
			},
			callbacks,
		);
		const provider = new GoogleCalendarProvider(auth);
		const peopleSearch = new GooglePeopleSearch(auth);
		return {auth, provider, peopleSearch};
	}
	}
}

/** Build the provider-specific auth config from settings. */
export function getAuthConfig(type: CalendarProviderType, settings: WhisperCalSettings): Record<string, string> {
	switch (type) {
	case "microsoft":
		return {
			tenantId: settings.tenantId,
			clientId: settings.clientId,
			cloudInstance: settings.cloudInstance,
			deviceLoginUrl: settings.deviceLoginUrl,
		};
	case "google":
		return {
			clientId: settings.googleClientId,
			clientSecret: settings.googleClientSecret,
		};
	}
}
