import {requestUrl} from "obsidian";
import type {CalendarAuth} from "./CalendarAuth";
import type {PeopleSearchProvider, PeopleSearchResult} from "./PeopleSearchProvider";

const PEOPLE_API_BASE = "https://people.googleapis.com/v1";

/**
 * Google People API search — searches contacts and directory.
 * Tries searchContacts first, falls back to searchDirectoryPeople for Workspace orgs.
 */
export class GooglePeopleSearch implements PeopleSearchProvider {
	private auth: CalendarAuth;

	constructor(auth: CalendarAuth) {
		this.auth = auth;
	}

	isAvailable(): boolean {
		return this.auth.isSignedIn();
	}

	async search(query: string): Promise<PeopleSearchResult[]> {
		if (query.length < 2 || !this.auth.isSignedIn()) return [];

		const token = await this.auth.getAccessToken();

		// Try personal contacts first
		try {
			const params = new URLSearchParams({
				query,
				readMask: "names,emailAddresses",
				pageSize: "8",
			});
			const response = await requestUrl({
				url: `${PEOPLE_API_BASE}/people:searchContacts?${params.toString()}`,
				method: "GET",
				headers: {Authorization: `Bearer ${token}`},
			});
			const data = response.json as {
				results?: Array<{
					person?: {
						names?: Array<{displayName?: string}>;
						emailAddresses?: Array<{value?: string}>;
					};
				}>;
			};
			const results = (data.results ?? [])
				.filter(r => r.person?.emailAddresses?.[0]?.value)
				.map(r => ({
					name: r.person!.names?.[0]?.displayName ?? "",
					email: (r.person!.emailAddresses![0]!.value!).toLowerCase(),
				}));
			if (results.length > 0) return results;
		} catch {
			// Contacts search unavailable — fall through to directory
		}

		// Fallback: Workspace directory search
		try {
			const params = new URLSearchParams({
				query,
				readMask: "names,emailAddresses",
				pageSize: "8",
				sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
			});
			const response = await requestUrl({
				url: `${PEOPLE_API_BASE}/people:searchDirectoryPeople?${params.toString()}`,
				method: "GET",
				headers: {Authorization: `Bearer ${token}`},
			});
			const data = response.json as {
				people?: Array<{
					names?: Array<{displayName?: string}>;
					emailAddresses?: Array<{value?: string}>;
				}>;
			};
			return (data.people ?? [])
				.filter(p => p.emailAddresses?.[0]?.value)
				.map(p => ({
					name: p.names?.[0]?.displayName ?? "",
					email: (p.emailAddresses![0]!.value!).toLowerCase(),
				}));
		} catch {
			return [];
		}
	}
}
