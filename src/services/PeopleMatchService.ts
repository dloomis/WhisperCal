import {App, TFolder} from "obsidian";
import {getMarkdownFilesRecursive} from "../utils/vault";
import {parseDisplayName} from "../utils/nameParser";
import type {EventAttendee} from "../types";

interface MatchedAttendee {
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

export interface PersonInfo {
	notePath: string;
	personnelType: string;
}

interface PeopleIndex {
	byEmail: Map<string, PersonInfo>;
	byName: Map<string, PersonInfo>;
}

export class PeopleMatchService {
	private app: App;
	private peopleFolderPath: string;

	constructor(app: App, peopleFolderPath: string) {
		this.app = app;
		this.peopleFolderPath = peopleFolderPath;
	}

	matchAttendees(attendees: EventAttendee[]): PeopleMatchResult {
		if (!this.peopleFolderPath) {
			return {matched: [], unmatched: [...attendees]};
		}

		const index = this.buildIndex();
		const matched: MatchedAttendee[] = [];
		const unmatched: EventAttendee[] = [];

		for (const attendee of attendees) {
			const info = this.lookupOne(index, attendee.email, attendee.name);
			if (info) {
				matched.push({name: attendee.name, email: attendee.email, notePath: info.notePath});
			} else {
				unmatched.push(attendee);
			}
		}

		return {matched, unmatched};
	}

	matchOne(name: string, email: string): string | null {
		if (!this.peopleFolderPath) return null;
		return this.lookupOne(this.buildIndex(), email, name)?.notePath ?? null;
	}

	matchOneInfo(name: string, email: string): PersonInfo | null {
		if (!this.peopleFolderPath) return null;
		return this.lookupOne(this.buildIndex(), email, name);
	}

	private lookupOne(index: PeopleIndex, email: string, name: string): PersonInfo | null {
		const emailLower = email.toLowerCase();
		const nameLower = name.toLowerCase();
		const normalized = parseDisplayName(name, email).toLowerCase();
		// Strip trailing digit suffixes (e.g. "francis lillian 2" → "francis lillian")
		const stripped = normalized.replace(/\s+\d+$/, "");
		return (emailLower ? index.byEmail.get(emailLower) : undefined)
			?? (nameLower ? index.byName.get(nameLower) : undefined)
			?? (normalized !== nameLower ? index.byName.get(normalized) : undefined)
			?? (stripped !== normalized ? index.byName.get(stripped) : undefined)
			?? null;
	}

	private buildIndex(): PeopleIndex {
		const byEmail = new Map<string, PersonInfo>();
		const byName = new Map<string, PersonInfo>();

		const folder = this.app.vault.getAbstractFileByPath(this.peopleFolderPath);
		if (!(folder instanceof TFolder)) {
			return {byEmail, byName};
		}

		const files = getMarkdownFilesRecursive(folder);

		for (const file of files) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;

			const notePath = file.path.replace(/\.md$/, "");
			const rawType: unknown = fm["personnel_type"];
			const personnelType = typeof rawType === "string" ? rawType : "";
			const info: PersonInfo = {notePath, personnelType};

			for (const field of EMAIL_FIELDS) {
				const value: unknown = fm[field];
				if (typeof value === "string" && value) {
					byEmail.set(value.toLowerCase(), info);
				}
			}

			const fullName: unknown = fm["full_name"];
			if (typeof fullName === "string" && fullName) {
				byName.set(fullName.toLowerCase(), info);
			}

			// Index note basename (e.g. "Alex Lillian") as a name variant
			const basename = file.basename.toLowerCase();
			if (!byName.has(basename)) {
				byName.set(basename, info);
			}

			// Index nickname + last name if available
			const nickname: unknown = fm["nickname"];
			if (typeof nickname === "string" && nickname && typeof fullName === "string" && fullName) {
				const lastWord = fullName.trim().split(/\s+/).pop();
				if (lastWord) {
					const nickLast = `${nickname} ${lastWord}`.toLowerCase();
					if (!byName.has(nickLast)) {
						byName.set(nickLast, info);
					}
				}
			}
		}

		return {byEmail, byName};
	}
}
