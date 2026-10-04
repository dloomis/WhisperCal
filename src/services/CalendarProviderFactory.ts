import type {CalendarProviderType, CalendarProvider} from "../types";
import type {WhisperCalSettings} from "../settings";
import type {CalendarAuth} from "./CalendarAuth";
import type {PeopleSearchProvider} from "./PeopleSearchProvider";
import type {AuthCallbacks} from "./auth/BaseCalendarAuth";
import {MsalAuth} from "./auth/MsalAuth";
import {GoogleAuth} from "./auth/GoogleAuth";
import {GraphApiProvider} from "./GraphApiProvider";
import {GraphPeopleSearch} from "./GraphPeopleSearch";
import {GoogleCalendarProvider} from "./GoogleCalendarProvider";
import {GooglePeopleSearch} from "./GooglePeopleSearch";

export interface CalendarStack {
	auth: CalendarAuth;
	provider: CalendarProvider;
	peopleSearch: PeopleSearchProvider;
}

/** Build the calendar stack (auth + calendar + people search) for the chosen provider. */
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
			},
			callbacks,
		);
		return {
			auth,
			provider: new GraphApiProvider(auth),
			peopleSearch: new GraphPeopleSearch(auth),
		};
	}
	case "google": {
		const auth = new GoogleAuth(
			{
				clientId: settings.googleClientId,
				clientSecret: settings.googleClientSecret,
			},
			callbacks,
		);
		return {
			auth,
			provider: new GoogleCalendarProvider(auth),
			peopleSearch: new GooglePeopleSearch(auth),
		};
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
		};
	case "google":
		return {
			clientId: settings.googleClientId,
			clientSecret: settings.googleClientSecret,
		};
	}
}
