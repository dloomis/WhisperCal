/**
 * Provider-agnostic interface for searching people by name/email.
 * Used by the settings UI for important organizers autocomplete.
 */
export interface PeopleSearchResult {
	name: string;
	email: string;
}

export interface PeopleSearchProvider {
	search(query: string): Promise<PeopleSearchResult[]>;
	isAvailable(): boolean;
}
