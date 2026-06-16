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

/**
 * Derive a "first last" name variant from an email local-part shaped like `first.last@…`.
 * People notes are emailed `first.last@org`, so a person's formal first name often lives ONLY
 * in the email (e.g. `douglas.sperber@…` for a note whose basename is "Doug Sperber"). Indexing
 * this variant lets the LLM's formal-name expansions resolve to the note with no per-note
 * curation. Returns "" when the local-part isn't a plausible multi-token name (e.g. `dsperber`).
 */
function nameVariantFromEmail(email: string): string {
	const local = email.split("@")[0] ?? "";
	const tokens = local.split(/[._-]+/).filter(t => /^[a-z]{2,}$/i.test(t));
	return tokens.length >= 2 ? tokens.join(" ").toLowerCase() : "";
}

export interface PersonInfo {
	notePath: string;
	personnelType: string;
	fullName: string;
	nickname: string;
	roleTitle: string;
	organization: string;
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

	/**
	 * Resolve a name (a basename, full_name, or nickname+lastname variant) to its canonical
	 * People-note basename — the identity that `confirmed_speakers` wikilinks resolve to. Returns
	 * null when no People note matches, so callers can fall back to the name as typed. This is the
	 * single source of truth that keeps voiceprint library names aligned with the People folder.
	 */
	canonicalName(name: string): string | null {
		if (!this.peopleFolderPath || !name.trim()) return null;
		const info = this.lookupOne(this.buildIndex(), "", name);
		if (!info) return null;
		return info.notePath.split("/").pop() ?? null;
	}

	/**
	 * Build a People Roster Markdown table for speaker tagging.
	 * Mic user is always included; invitees are enriched up to maxEnriched rows.
	 * Returns empty string if no names to include.
	 */
	buildRoster(microphoneUser: string, inviteeNames: string[], maxEnriched: number): string {
		if (!this.peopleFolderPath && !microphoneUser && inviteeNames.length === 0) return "";

		const index = this.buildIndex();
		const rows: {fullName: string; nickname: string; context: string; noteFilename: string; source: string}[] = [];
		const seen = new Set<string>();

		const addRow = (name: string, source: string): boolean => {
			if (!name) return false;
			const key = name.toLowerCase();
			if (seen.has(key)) return false;
			if (rows.length >= maxEnriched) return false;
			seen.add(key);

			const info = this.lookupOne(index, "", name);
			const fullName = info?.fullName || name;
			const nickname = info?.nickname || "";
			const role = info?.roleTitle || "";
			const org = info?.organization || "";
			const context = role && org ? `${role}, ${org}` : role || org;
			const noteFilename = info ? info.notePath.split("/").pop() ?? "" : "";
			rows.push({fullName, nickname, context, noteFilename, source});
			return true;
		};

		if (microphoneUser) addRow(microphoneUser, "microphone_user");
		for (const name of inviteeNames) addRow(name, "calendar");

		if (rows.length === 0) return "";

		const header = "| Full Name | Nickname | Context | People Note Filename | Source |";
		const sep = "|-----------|----------|---------|---------------------|--------|";
		const body = rows.map(r =>
			`| ${r.fullName} | ${r.nickname} | ${r.context} | ${r.noteFilename} | ${r.source} |`
		);
		return [header, sep, ...body].join("\n");
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
		// Email-derived name variants, applied in a final pass (see below) so they never
		// outrank a real basename/full_name/nickname from any note.
		const pendingEmailVariants: {key: string; info: PersonInfo}[] = [];

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
			const fullName: unknown = fm["full_name"];
			const nickname: unknown = fm["nickname"];
			const rawRole: unknown = fm["role_title"];
			const rawOrg: unknown = fm["organization"] ?? fm["company"];
			const info: PersonInfo = {
				notePath,
				personnelType,
				fullName: typeof fullName === "string" ? fullName : "",
				nickname: typeof nickname === "string" ? nickname : "",
				roleTitle: typeof rawRole === "string" ? rawRole : "",
				organization: typeof rawOrg === "string" ? rawOrg : "",
			};

			for (const field of EMAIL_FIELDS) {
				const value: unknown = fm[field];
				if (typeof value === "string" && value) {
					byEmail.set(value.toLowerCase(), info);
					// Defer the email-derived "first last" variant (the formal first name often
					// lives only in the email, e.g. douglas.sperber@… for a "Doug Sperber" note).
					const variant = nameVariantFromEmail(value);
					if (variant) pendingEmailVariants.push({key: variant, info});
				}
			}

			if (typeof fullName === "string" && fullName) {
				byName.set(fullName.toLowerCase(), info);
			}

			// Index note basename (e.g. "Alex Lillian") as a name variant
			const basename = file.basename.toLowerCase();
			if (!byName.has(basename)) {
				byName.set(basename, info);
			}

			// Index nickname + last name if available
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

		// Lowest-priority name variants: an email-derived "first last" only fills a name key
		// that no note already claims via basename/full_name/nickname. Applied after the main
		// loop so strong variants from every note are present first.
		for (const {key, info} of pendingEmailVariants) {
			if (!byName.has(key)) byName.set(key, info);
		}

		return {byEmail, byName};
	}
}
