import {requestUrl} from "obsidian";
import type {CalendarAuth} from "./CalendarAuth";
import type {PeopleSearchProvider, PeopleSearchResult} from "./PeopleSearchProvider";
import type {MsalAuth} from "./MsalAuth";

/**
 * Microsoft Graph people search — extracted from settings.ts.
 * Tries /me/people first (People.Read), falls back to /users (User.ReadBasic.All).
 */
export class GraphPeopleSearch implements PeopleSearchProvider {
	private auth: MsalAuth;

	constructor(auth: CalendarAuth) {
		this.auth = auth as MsalAuth;
	}

	isAvailable(): boolean {
		return this.auth.isSignedIn();
	}

	async search(query: string): Promise<PeopleSearchResult[]> {
		if (query.length < 2 || !this.auth.isSignedIn()) return [];

		const token = await this.auth.getAccessToken();
		const graphBase = this.auth.getGraphBaseUrl();

		// Try /me/people first (People.Read)
		try {
			const encoded = encodeURIComponent(`"${query}"`);
			const response = await requestUrl({
				url: `${graphBase}/v1.0/me/people?$search=${encoded}&$top=8&$select=displayName,scoredEmailAddresses`,
				method: "GET",
				headers: {Authorization: `Bearer ${token}`},
			});
			const data = response.json as {
				value?: Array<{
					displayName?: string;
					scoredEmailAddresses?: Array<{address?: string}>;
				}>;
			};
			const results = (data.value ?? [])
				.filter(p => p.scoredEmailAddresses?.[0]?.address)
				.map(p => ({
					name: p.displayName ?? "",
					email: (p.scoredEmailAddresses![0]!.address!).toLowerCase(),
				}));
			if (results.length > 0) return results;
		} catch {
			// People API unavailable — fall through to /users
		}

		// Fallback: /users directory search (User.ReadBasic.All)
		try {
			const searchExpr = encodeURIComponent(`"displayName:${query}"`);
			const response = await requestUrl({
				url: `${graphBase}/v1.0/users?$search=${searchExpr}&$top=8&$select=displayName,mail,userPrincipalName`,
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					ConsistencyLevel: "eventual",
				},
			});
			const data = response.json as {
				value?: Array<{
					displayName?: string;
					mail?: string;
					userPrincipalName?: string;
				}>;
			};
			return (data.value ?? [])
				.filter(u => u.mail || u.userPrincipalName)
				.map(u => ({
					name: u.displayName ?? "",
					email: (u.mail ?? u.userPrincipalName ?? "").toLowerCase(),
				}));
		} catch {
			return [];
		}
	}
}
