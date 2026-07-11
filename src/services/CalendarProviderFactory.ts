import type {App} from "obsidian";
import type {CalendarProviderType, CalendarProvider} from "../types";
import type {CalendarAuth} from "./CalendarAuth";
import type {PeopleSearchProvider} from "./PeopleSearchProvider";
import {CoreCalendarAuth} from "./CoreCalendarAuth";
import {GraphApiProvider} from "./GraphApiProvider";
import {GraphPeopleSearch} from "./GraphPeopleSearch";
import {GoogleCalendarProvider} from "./GoogleCalendarProvider";
import {GooglePeopleSearch} from "./GooglePeopleSearch";

export interface CalendarStack {
	auth: CalendarAuth;
	provider: CalendarProvider;
	peopleSearch: PeopleSearchProvider;
}

/**
 * Build the calendar stack for the chosen provider. Auth is a thin
 * CoreCalendarAuth delegating to the WhisperCore API (DESIGN §8.2) — provider
 * config and tokens live in Core; WhisperCal only selects which provider Core
 * should answer for.
 */
export function createCalendarStack(
	type: CalendarProviderType,
	app: App,
): CalendarStack {
	const auth = new CoreCalendarAuth(app, type);
	switch (type) {
	case "microsoft":
		return {
			auth,
			provider: new GraphApiProvider(auth),
			peopleSearch: new GraphPeopleSearch(auth),
		};
	case "google":
		return {
			auth,
			provider: new GoogleCalendarProvider(auth),
			peopleSearch: new GooglePeopleSearch(auth),
		};
	}
}
