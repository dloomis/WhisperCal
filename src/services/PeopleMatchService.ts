import {App, TFolder} from "obsidian";
import {getMarkdownFilesRecursive} from "../utils/vault";
import type {EventAttendee} from "../types";

export interface MatchedAttendee {
	name: string;
	email: string;
	notePath: string;
}

export interface PeopleMatchResult {
	matched: MatchedAttendee[];
	unmatched: EventAttendee[];
}

const EMAIL_FIELDS = [
	"company_email",
	"personal_email",
	"sipr_email",
	"nipr_email",
	"preferred_email",
] as const;

interface PeopleIndex {
	byEmail: Map<string, string>;
	byName: Map<string, string>;
}

export class PeopleMatchService {
	private app: App;
	private peopleFolderPath: string;
	private index: PeopleIndex | null = null;

	constructor(app: App, peopleFolderPath: string) {
		this.app = app;
		this.peopleFolderPath = peopleFolderPath;
	}

	matchAttendees(attendees: EventAttendee[]): PeopleMatchResult {
		if (!this.peopleFolderPath) {
			return {matched: [], unmatched: [...attendees]};
		}

		const index = this.getIndex();
		const matched: MatchedAttendee[] = [];
		const unmatched: EventAttendee[] = [];

		for (const attendee of attendees) {
			const notePath = this.lookupOne(index, attendee.email, attendee.name);
			if (notePath) {
				matched.push({name: attendee.name, email: attendee.email, notePath});
			} else {
				unmatched.push(attendee);
			}
		}

		return {matched, unmatched};
	}

	matchOne(name: string, email: string): string | null {
		if (!this.peopleFolderPath) return null;
		return this.lookupOne(this.getIndex(), email, name);
	}

	private lookupOne(index: PeopleIndex, email: string, name: string): string | null {
		const emailLower = email.toLowerCase();
		const nameLower = name.toLowerCase();
		return (emailLower ? index.byEmail.get(emailLower) : undefined)
			?? (nameLower ? index.byName.get(nameLower) : undefined)
			?? null;
	}

	private getIndex(): PeopleIndex {
		if (!this.index) {
			this.index = this.buildIndex();
		}
		return this.index;
	}

	private buildIndex(): PeopleIndex {
		const byEmail = new Map<string, string>();
		const byName = new Map<string, string>();

		const folder = this.app.vault.getAbstractFileByPath(this.peopleFolderPath);
		if (!(folder instanceof TFolder)) {
			return {byEmail, byName};
		}

		const files = getMarkdownFilesRecursive(folder);

		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (!fm) continue;

			const notePath = file.path.replace(/\.md$/, "");

			// Index all email fields
			for (const field of EMAIL_FIELDS) {
				const value: unknown = fm[field];
				if (typeof value === "string" && value) {
					byEmail.set(value.toLowerCase(), notePath);
				}
			}

			// Index full_name
			const fullName: unknown = fm["full_name"];
			if (typeof fullName === "string" && fullName) {
				byName.set(fullName.toLowerCase(), notePath);
			}
		}

		return {byEmail, byName};
	}

}
