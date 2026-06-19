import {App, TFile, TFolder} from "obsidian";
import type {CalendarEvent} from "../types";
import {PeopleMatchService} from "./PeopleMatchService";
import {getMarkdownFilesRecursive, ensureFolder} from "../utils/vault";
import {parseDisplayName} from "../utils/nameParser";
import {sanitizeFilename} from "../utils/sanitize";
import {applyTemplate} from "./TemplateEngine";

/** Keywords in organizer name that indicate a team, resource, or system account. */
const TEAM_NAME_RE = /\b(team|calendar|workflow|room|conference|resource|group|mailbox|shared|events|noreply|donotreply|notifications|service)\b/i;

/** Email domains that are always non-person (group calendars, etc.). */
const GROUP_DOMAINS = new Set(["group.calendar.google.com"]);

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

	// .mil domains are too varied to auto-label
	if (domain.endsWith(".mil")) return "";

	// Capitalize first segment of domain
	const seg = domain.split(".")[0] ?? "";
	if (!seg || /^\d/.test(seg)) return "";
	return seg.charAt(0).toUpperCase() + seg.slice(1);
}

/**
 * Build the template variable map for a People note.
 */
function buildPeopleVariableMap(fullName: string, email: string): Record<string, string> {
	const nickname = fullName.split(/\s+/)[0] ?? "";
	const organization = deriveOrg(email);
	return {
		full_name: fullName,
		nickname,
		email,
		organization,
	};
}

/**
 * Scan events for organizers that don't have a matching People note
 * and create notes from the user-provided template for ones that look like real people.
 */
export async function autoCreatePeopleNotes(
	app: App,
	peopleFolderPath: string,
	templatePath: string,
	events: CalendarEvent[],
	userEmail: string,
): Promise<void> {
	if (!peopleFolderPath || !templatePath) return;

	const folder = app.vault.getAbstractFileByPath(peopleFolderPath);
	if (!(folder instanceof TFolder)) return;

	const templateFile = app.vault.getAbstractFileByPath(templatePath);
	if (!(templateFile instanceof TFile)) return;

	const template = await app.vault.cachedRead(templateFile);
	if (!template) return;

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

	// Deduplicate organizers by email, keeping the first meeting subject
	const seen = new Set<string>();
	const organizers: {name: string; email: string; meetingSubject: string}[] = [];

	for (const event of events) {
		if (!event.organizerEmail || !event.organizerName) continue;
		const emailLower = event.organizerEmail.toLowerCase();
		if (emailLower === userLower) continue;
		if (seen.has(emailLower)) continue;
		seen.add(emailLower);
		organizers.push({name: event.organizerName, email: event.organizerEmail, meetingSubject: event.subject});
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

		const variables = buildPeopleVariableMap(parsed, org.email);
		let content = applyTemplate(template, variables);
		content += `\n\n> [!info] Auto-created\n> Organizer of **${org.meetingSubject}**\n`;
		await app.vault.create(path, content);
		created++;
		console.debug(`[WhisperCal] Auto-created People note: ${path}`);
	}

	if (created > 0) {
		console.debug(`[WhisperCal] Auto-created ${created} People note(s)`);
	}
}

/**
 * Auto-create People notes for confirmed speaker names that are truly new: no existing note
 * matches by name/email, AND no existing note shares the surname (the "Steve Martin" vs
 * "Steven Martin" guard — a name variant almost certainly already has a note). Reuses the
 * people template when one is configured, otherwise writes a minimal `full_name` stub so a
 * freshly-tagged speaker always has a note for voiceprints to align to. Best-effort; returns
 * the basenames of the notes it actually created.
 */
export async function createPeopleNotesForNames(
	app: App,
	peopleFolderPath: string,
	templatePath: string,
	names: string[],
	contextLabel?: string,
): Promise<string[]> {
	if (!peopleFolderPath || names.length === 0) return [];

	await ensureFolder(app, peopleFolderPath);
	const folder = app.vault.getAbstractFileByPath(peopleFolderPath);
	if (!(folder instanceof TFolder)) return [];

	// The template is optional on this path (unlike the calendar-organizer path): a tagged
	// speaker should always land a note, so fall back to a minimal stub when none is set.
	let template = "";
	const templateFile = templatePath ? app.vault.getAbstractFileByPath(templatePath) : null;
	if (templateFile instanceof TFile) template = await app.vault.cachedRead(templateFile);

	const peopleSvc = new PeopleMatchService(app, peopleFolderPath);

	// Existing surnames for the variance guard. See autoCreatePeopleNotes above.
	const existingLastNames = new Set<string>();
	for (const file of getMarkdownFilesRecursive(folder)) {
		const last = file.basename.split(/\s+/).pop();
		if (last) existingLastNames.add(last.toLowerCase());
	}

	const created: string[] = [];
	const handled = new Set<string>();
	for (const raw of names) {
		const name = raw.trim();
		if (!name) continue;

		const parsed = cleanParsedName(parseDisplayName(name, ""));
		const key = parsed.toLowerCase();
		if (handled.has(key)) continue;
		handled.add(key);

		// Filter stubs / single-token labels (e.g. "Speaker 2" cleans to "Speaker").
		if (!isLikelyPerson(name, "")) continue;

		// Already covered by an existing note (exact or normalized name match).
		if (peopleSvc.matchOne(name, "") || peopleSvc.matchOne(parsed, "")) continue;

		// Same surname already on file — almost certainly a variant of an existing person.
		const lastName = parsed.split(/\s+/).pop();
		if (lastName && existingLastNames.has(lastName.toLowerCase())) continue;

		const path = `${peopleFolderPath}/${sanitizeFilename(parsed)}.md`;
		if (app.vault.getAbstractFileByPath(path)) continue;

		try {
			let content = template
				? applyTemplate(template, buildPeopleVariableMap(parsed, ""))
				: `---\nfull_name: "${parsed}"\n---\n`;
			if (contextLabel) content += `\n\n> [!info] Auto-created\n> Speaker in **${contextLabel}**\n`;
			await app.vault.create(path, content);
			created.push(parsed);
			console.debug(`[WhisperCal] Auto-created People note from speaker tag: ${path}`);
		} catch (e) {
			console.warn(`[WhisperCal] failed to auto-create People note "${parsed}"`, e);
		}
	}

	return created;
}
