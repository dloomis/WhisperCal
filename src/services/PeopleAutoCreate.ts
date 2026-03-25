import {App, TFolder} from "obsidian";
import type {CalendarEvent} from "../types";
import {PeopleMatchService} from "./PeopleMatchService";
import {getMarkdownFilesRecursive} from "../utils/vault";
import {parseDisplayName} from "../utils/nameParser";
import {sanitizeFilename, yamlEscape} from "../utils/sanitize";

/** Keywords in organizer name that indicate a team, resource, or system account. */
const TEAM_NAME_RE = /\b(team|calendar|workflow|room|conference|resource|group|mailbox|shared|events|noreply|donotreply|notifications|service)\b/i;

/** Email domains that are always non-person (group calendars, etc.). */
const GROUP_DOMAINS = new Set(["group.calendar.google.com"]);

/** Map well-known email domains to organization names. */
const DOMAIN_ORG: Record<string, string> = {
	"microsoft.com": "Microsoft",
	"broadcom.com": "Broadcom",
	"l3harris.com": "L3Harris",
	"spa.com": "SPA",
	"aero.org": "The Aerospace Corporation",
	"mtsi-va.com": "MTSI",
	"mantech.com": "ManTech",
	"parsons.com": "Parsons",
};

/** Strip noise words that email-derived names pick up (e.g. "ctr", lone digits). */
function cleanParsedName(name: string): string {
	return name
		.split(/\s+/)
		.filter(w => !/^\d+$/.test(w) && !/^ctr$/i.test(w))
		.join(" ")
		.trim();
}

function isLikelyPerson(name: string, email: string): boolean {
	if (TEAM_NAME_RE.test(name)) return false;

	const domain = (email.split("@")[1] ?? "").toLowerCase();
	if (GROUP_DOMAINS.has(domain)) return false;

	// Parsed + cleaned name must have at least first + last
	const parsed = cleanParsedName(parseDisplayName(name, email));
	const parts = parsed.split(/\s+/);
	if (parts.length < 2) return false;

	// First name starting with a digit is a system account, not a person
	if (/^\d/.test(parts[0]!)) return false;

	return true;
}

function deriveOrg(email: string): string {
	const domain = (email.split("@")[1] ?? "").toLowerCase();
	const mapped = DOMAIN_ORG[domain];
	if (mapped) return mapped;

	// .mil domains are too varied to auto-label
	if (domain.endsWith(".mil")) return "";

	// Generic fallback: capitalize first segment of domain
	const seg = domain.split(".")[0] ?? "";
	if (!seg || /^\d/.test(seg)) return "";
	return seg.charAt(0).toUpperCase() + seg.slice(1);
}

function derivePersonnelType(email: string): string {
	if (/\.ctr[.@]/i.test(email)) return "Contractor";
	return "";
}

function buildPeopleNoteContent(fullName: string, email: string, originalName: string): string {
	const nickname = fullName.split(/\s+/)[0] ?? "";
	const org = deriveOrg(email);
	const personnelType = derivePersonnelType(email);
	const e = yamlEscape;

	const lines = [
		"---",
		`full_name: "${e(fullName)}"`,
		`nickname: "${e(nickname)}"`,
		`role_title: ""`,
		`company/org: "${e(org)}"`,
		`manager: ""`,
		`program: ""`,
		`team: ""`,
		`company_email: "${e(email)}"`,
		`personal_email: ""`,
		`sipr_email: ""`,
		`nipr_email: ""`,
		`preferred_email: "${e(email)}"`,
		`mattermost_username: ""`,
		`office_phone: ""`,
		`mobile_phone: ""`,
		`website: ""`,
		`location: ""`,
		`interests: []`,
		`org: ""`,
		`org_l1: []`,
		`org_l2: []`,
		`org_l3: []`,
		`reports_to: ""`,
		`grade: ""`,
		`personnel_type: "${e(personnelType)}"`,
		`mcl_area: ""`,
		`type: person`,
		`organization_level: individual`,
		`key_responsibilities: []`,
		`expertise_areas: []`,
		`direct_reports: []`,
		`keywords: []`,
		`related_notes: []`,
		`projects: []`,
		`vocatives: []`,
		`typical_meetings: []`,
		`microphone_user: false`,
		`obsidianUIMode: preview`,
		"---",
		"#people",
		"",
		"## Quick Notes",
		"",
		`- Auto-created from calendar organizer "${originalName}"`,
		"",
		"## Notes",
		"",
		"",
		"## Hot Takes",
		"```dataview ",
		'TABLE WITHOUT ID q as "Hot Take", file.link as "Meeting"',
		'FROM "6 Meeting Summaries"',
		"FLATTEN quote as q",
		"WHERE contains(q, this.file.name)",
		"SORT file.cday DESC",
		"```",
		"",
		"## Meetings",
		"```dataview",
		'TABLE file.cday as Created, summary AS "Summary"',
		'FROM "6 Meeting Summaries" where contains(file.outlinks, this.file.link)',
		"SORT file.cday DESC",
		"```",
		"",
	];
	return lines.join("\n");
}

/**
 * Scan events for organizers that don't have a matching People note
 * and create minimal People notes for ones that look like real people.
 */
export async function autoCreatePeopleNotes(
	app: App,
	peopleFolderPath: string,
	events: CalendarEvent[],
	userEmail: string,
): Promise<void> {
	if (!peopleFolderPath) return;

	const folder = app.vault.getAbstractFileByPath(peopleFolderPath);
	if (!(folder instanceof TFolder)) return;

	const peopleSvc = new PeopleMatchService(app, peopleFolderPath);
	const userLower = userEmail.toLowerCase();

	// Build a set of existing People note last names for fuzzy duplicate detection.
	// Catches variants like "Steve Martin" vs "Steven Martin" or "Anne Marie Salter"
	// vs "Annemarie Salter" — same last name means a note likely already covers them.
	const existingLastNames = new Set<string>();
	for (const file of getMarkdownFilesRecursive(folder)) {
		const stem = file.basename;
		const last = stem.split(/\s+/).pop();
		if (last) existingLastNames.add(last.toLowerCase());
	}

	// Deduplicate organizers by email
	const seen = new Set<string>();
	const organizers: {name: string; email: string}[] = [];

	for (const event of events) {
		if (!event.organizerEmail || !event.organizerName) continue;
		const emailLower = event.organizerEmail.toLowerCase();
		if (emailLower === userLower) continue;
		if (seen.has(emailLower)) continue;
		seen.add(emailLower);
		organizers.push({name: event.organizerName, email: event.organizerEmail});
	}

	let created = 0;
	for (const org of organizers) {
		if (!isLikelyPerson(org.name, org.email)) continue;

		// Check both original name and cleaned parsed name against People index
		const parsed = cleanParsedName(parseDisplayName(org.name, org.email));
		if (peopleSvc.matchOne(org.name, org.email)) continue;
		if (peopleSvc.matchOne(parsed, org.email)) continue;

		// Skip if a People note with the same last name already exists —
		// likely a name variant (e.g. "Steve" vs "Steven")
		const lastName = parsed.split(/\s+/).pop();
		if (lastName && existingLastNames.has(lastName.toLowerCase())) continue;

		const filename = sanitizeFilename(parsed) + ".md";
		const path = `${peopleFolderPath}/${filename}`;

		// File may already exist under this path even if the index didn't match
		if (app.vault.getAbstractFileByPath(path)) continue;

		const content = buildPeopleNoteContent(parsed, org.email, org.name);
		await app.vault.create(path, content);
		created++;
		console.debug(`[WhisperCal] Auto-created People note: ${path}`);
	}

	if (created > 0) {
		console.debug(`[WhisperCal] Auto-created ${created} People note(s)`);
	}
}
