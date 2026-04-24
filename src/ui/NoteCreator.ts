import {App, MarkdownView, TFile, TFolder, WorkspaceLeaf, normalizePath} from "obsidian";
import type {CalendarEvent} from "../types";
import type {WhisperCalSettings} from "../settings";
import {formatDate} from "../utils/time";
import {sanitizeFilename, yamlEscape} from "../utils/sanitize";
import {ensureFolder, getMarkdownFilesRecursive} from "../utils/vault";
import {applyTemplate, buildVariableMap, loadTemplate} from "../services/TemplateEngine";
import {PeopleMatchService} from "../services/PeopleMatchService";

export class NoteCreator {
	private app: App;
	private settings: WhisperCalSettings;

	constructor(app: App, settings: WhisperCalSettings) {
		this.app = app;
		this.settings = settings;
	}

	getNotePath(event: CalendarEvent): string {
		const date = formatDate(event.startTime, this.settings.timezone);
		const subject = sanitizeFilename(event.subject);
		const filename = this.settings.noteFilenameTemplate
			.replace("{{date}}", date)
			.replace("{{subject}}", subject);
		return normalizePath(`${this.settings.noteFolderPath}/${filename}.md`);
	}

	/**
	 * Find the meeting note for an event by frontmatter, not filename.
	 * Tries the canonical template path first (fast), then scans the note
	 * folder for a file whose frontmatter `calendar_event_id` or
	 * `meeting_subject` + `meeting_date` match the event.
	 */
	findNote(event: CalendarEvent): TFile | null {
		// Fast path: canonical template path
		const canonical = this.getNotePath(event);
		const abs = this.app.vault.getAbstractFileByPath(canonical);
		if (abs instanceof TFile) return abs;

		// Scan note folder by frontmatter (recursively to cover subfolders)
		const folder = this.app.vault.getAbstractFileByPath(this.settings.noteFolderPath);
		if (!(folder instanceof TFolder)) return null;

		const files = getMarkdownFilesRecursive(folder);
		const date = formatDate(event.startTime, this.settings.timezone);

		for (const child of files) {
			const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
			if (!fm) continue;

			// Match on calendar_event_id AND meeting_date. MS Graph occasionally
			// returns the same `id` for different occurrences of a recurring
			// series, so event_id alone would collapse sibling occurrences onto
			// one note (causing e.g. an LLM job on Thursday's note to appear as
			// running on Tuesday's card).
			if (fm["calendar_event_id"] === event.id && fm["meeting_date"] === date) return child;

			// Match on meeting_subject + meeting_date
			if (fm["meeting_subject"] === event.subject && fm["meeting_date"] === date) {
				return child;
			}
		}

		// Last resort: match notes whose basename contains the subject and
		// whose frontmatter Date (or meeting_date) falls on the same day.
		// Catches legacy notes created outside WhisperCal.
		const subject = sanitizeFilename(event.subject);
		for (const child of files) {
			if (!child.basename.includes(subject)) continue;
			const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
			if (!fm) continue;
			const fmDate = (fm["meeting_date"] ?? fm["Date"] ?? "") as string;
			if (typeof fmDate === "string" && fmDate.startsWith(date)) return child;
		}
		return null;
	}

	noteExists(event: CalendarEvent): boolean {
		return this.findNote(event) !== null;
	}

	async openExistingNote(event: CalendarEvent): Promise<void> {
		const file = this.findNote(event);
		if (file) {
			const leaf = this.getLeafForFile(file);
			await leaf.openFile(file);
			const content = await this.app.vault.read(file);
			this.setCursorToNotesSection(leaf, content);
		}
	}

	async createNote(event: CalendarEvent, opts?: {preserveTimestamps?: boolean}): Promise<void> {
		const path = this.getNotePath(event);

		// If note already exists, just open it
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const leaf = this.getLeafForFile(existing);
			await leaf.openFile(existing);
			return;
		}

		// Ensure folder exists
		await ensureFolder(this.app, this.settings.noteFolderPath);

		const noteCreated = new Date();

		// For unscheduled events, stamp the actual creation time so
		// frontmatter records a real meeting_start and the card can
		// render inline at the correct time slot.
		const effectiveEvent = event.id === "unscheduled" && !opts?.preserveTimestamps
			? {...event, startTime: noteCreated, endTime: noteCreated}
			: event;

		const content = await this.buildNoteContent(effectiveEvent, noteCreated);
		if (!content) return;
		const file = await this.app.vault.create(path, content);
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file);
		this.setCursorToNotesSection(leaf, content);
	}

	/** Reuse an existing leaf showing this file, or open a new tab. */
	private getLeafForFile(file: TFile): WorkspaceLeaf {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if ((leaf.view as MarkdownView).file?.path === file.path) {
				this.app.workspace.setActiveLeaf(leaf, {focus: true});
				return leaf;
			}
		}
		return this.app.workspace.getLeaf("tab");
	}

	private setCursorToNotesSection(leaf: WorkspaceLeaf, content: string): void {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		const editor = view.editor;

		const lines = content.split("\n");
		// Find the last "## Notes" or "# Notes" heading
		let headingLine = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (/^#{1,6}\s+Notes\s*$/i.test(lines[i] as string)) {
				headingLine = i;
				break;
			}
		}

		if (headingLine < 0) {
			// No notes header — place cursor at end of file
			editor.setCursor({line: editor.lastLine(), ch: 0});
			editor.focus();
			return;
		}

		// Ensure two blank lines after the heading, then place cursor there.
		// Skip past any existing blank lines to find the first content line.
		let firstContentLine = headingLine + 1;
		while (firstContentLine < lines.length && lines[firstContentLine]!.trim() === "") {
			firstContentLine++;
		}

		const blanksNeeded = 2;
		const existingBlanks = firstContentLine - headingLine - 1;

		if (existingBlanks < blanksNeeded) {
			// Insert missing blank lines right after the heading
			const insertAt = {line: headingLine + 1, ch: 0};
			editor.replaceRange("\n".repeat(blanksNeeded - existingBlanks), insertAt);
		}

		// Cursor goes on the last blank line (line after heading + 1 blank = 2 lines down)
		editor.setCursor({line: headingLine + blanksNeeded, ch: 0});
		editor.focus();
	}

	private async buildNoteContent(event: CalendarEvent, noteCreated: Date): Promise<string | null> {
		const template = await loadTemplate(this.app, this.settings.noteTemplatePath);
		if (!template) return null;
		const peopleSvc = new PeopleMatchService(this.app, this.settings.peopleFolderPath);
		const peopleMatch = peopleSvc.matchAttendees(event.attendees);
		const organizerNotePath = peopleSvc.matchOne(event.organizerName, event.organizerEmail);
		const variables = buildVariableMap(event, this.settings.timezone, peopleMatch, organizerNotePath, noteCreated);
		const content = applyTemplate(template, variables);
		return this.injectReservedFrontmatter(content, event, variables);
	}

	/**
	 * Inject plugin-managed frontmatter keys into the note content.
	 * These are not part of the user template — the plugin owns them.
	 */
	private injectReservedFrontmatter(
		content: string,
		event: CalendarEvent,
		variables: Record<string, string>,
	): string {
		const inviteeLines = event.attendees.length > 0
			? "\n" + variables["invitees"]
			: "";
		const reserved = [
			`meeting_subject: "${yamlEscape(event.subject)}"`,
			`meeting_date: "${yamlEscape(variables["date"] ?? "")}"`,
			`meeting_start: "${yamlEscape(variables["startTime"] ?? "")}"`,
			`meeting_end: "${yamlEscape(variables["endTime"] ?? "")}"`,
			`meeting_location: "${yamlEscape(variables["location"] ?? "")}"`,
			`meeting_invitees:${inviteeLines}`,
			`meeting_organizer: "${yamlEscape(variables["organizer"] ?? "")}"`,
			`tags: [meeting]`,
			`calendar_event_id: "${yamlEscape(event.id)}"`,
			`calendar_provider: ${this.settings.calendarProvider}`,
			`is_recurring: ${event.isRecurring}`,
		].join("\n");

		// Insert before the closing --- of frontmatter
		const closingIdx = content.indexOf("\n---", 1);
		if (closingIdx === -1) return content;
		return content.slice(0, closingIdx) + "\n" + reserved + content.slice(closingIdx);
	}
}
