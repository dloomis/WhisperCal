import type {CalendarProviderType, CalendarProvider} from "../types";
import type {WhisperCalSettings} from "../settings";
import type {CalendarAuth} from "./CalendarAuth";
import type {PeopleSearchProvider} from "./PeopleSearchProvider";
import type {AuthCallbacks} from "./auth/BaseCalendarAuth";
import {MsalAuth, type MsalAuthConfig} from "./auth/MsalAuth";
import {GoogleAuth, type GoogleAuthConfig} from "./auth/GoogleAuth";
import {GraphApiProvider} from "./GraphApiProvider";
import {GraphPeopleSearch} from "./GraphPeopleSearch";
import {GoogleCalendarProvider} from "./GoogleCalendarProvider";
import {GooglePeopleSearch} from "./GooglePeopleSearch";

export interface CalendarStack {
	auth: CalendarAuth;
	provider: CalendarProvider;
	peopleSearch: PeopleSearchProvider;
	/** Push edited settings (client ID, tenant, …) into the live auth. */
	updateAuthConfig: (settings: WhisperCalSettings) => void;
}

function msalConfig(settings: WhisperCalSettings): MsalAuthConfig {
	return {
		tenantId: settings.tenantId,
		clientId: settings.clientId,
		cloudInstance: settings.cloudInstance,
	};
}

function googleConfig(settings: WhisperCalSettings): GoogleAuthConfig {
	return {
		clientId: settings.googleClientId,
		clientSecret: settings.googleClientSecret,
	};
}

/** Build the calendar stack (auth + calendar + people search) for the chosen provider. */
export function createCalendarStack(
	type: CalendarProviderType,
	settings: WhisperCalSettings,
	callbacks: AuthCallbacks,
): CalendarStack {
	switch (type) {
	case "microsoft": {
		const auth = new MsalAuth(msalConfig(settings), callbacks);
		return {
			auth,
			provider: new GraphApiProvider(auth),
			peopleSearch: new GraphPeopleSearch(auth),
			updateAuthConfig: s => auth.updateConfig(msalConfig(s)),
		};
	}
	case "google": {
		const auth = new GoogleAuth(googleConfig(settings), callbacks);
		return {
			auth,
			provider: new GoogleCalendarProvider(auth),
			peopleSearch: new GooglePeopleSearch(auth),
			updateAuthConfig: s => auth.updateConfig(googleConfig(s)),
		};
	}
	}
}
