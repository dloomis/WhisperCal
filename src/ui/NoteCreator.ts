import {App, MarkdownView, TFile, TFolder, WorkspaceLeaf, normalizePath} from "obsidian";
import type {CalendarEvent} from "../types";
import type {WhisperCalSettings} from "../settings";
import {formatDate} from "../utils/time";
import {sanitizeFilename} from "../utils/sanitize";
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

	noteExists(event: CalendarEvent): boolean {
		const path = this.getNotePath(event);
		return this.app.vault.getAbstractFileByPath(path) instanceof TFile;
	}

	async openExistingNote(event: CalendarEvent): Promise<void> {
		const path = this.getNotePath(event);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const leaf = this.getLeafForFile(file);
			await leaf.openFile(file);
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
		await this.ensureFolder(this.settings.noteFolderPath);

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

	private async ensureFolder(folderPath: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) {
			return;
		}
		try {
			await this.app.vault.createFolder(folderPath);
		} catch {
			// Folder may already exist (race condition)
		}
	}

	private setCursorToNotesSection(leaf: WorkspaceLeaf, content: string): void {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		const editor = view.editor;

		const lines = content.split("\n");
		// Find the last "## Notes" or "# Notes" heading
		let targetLine = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (/^#{1,6}\s+Notes\s*$/i.test(lines[i] as string)) {
				targetLine = i + 1;
				break;
			}
		}

		if (targetLine < 0) {
			// No notes header — place cursor at end of file
			targetLine = editor.lastLine();
		}

		editor.setCursor({line: targetLine, ch: 0});
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
		return this.injectReservedFrontmatter(content, event, variables, noteCreated);
	}

	/**
	 * Inject plugin-managed frontmatter keys into the note content.
	 * These are not part of the user template — the plugin owns them.
	 */
	private injectReservedFrontmatter(
		content: string,
		event: CalendarEvent,
		variables: Record<string, string>,
		noteCreated: Date,
	): string {
		const inviteeLines = event.attendees.length > 0
			? "\n" + variables["invitees"]
			: "";
		const reserved = [
			`meeting_subject: "${event.subject}"`,
			`meeting_date: "${variables["date"]}"`,
			`meeting_start: "${variables["startTime"]}"`,
			`meeting_end: "${variables["endTime"]}"`,
			`meeting_location: "${variables["location"]}"`,
			`meeting_invitees:${inviteeLines}`,
			`meeting_organizer: "${variables["organizer"]}"`,
			`tags: [meeting]`,
			`calendar_event_id: "${event.id}"`,
			`note_created: "${noteCreated.toISOString()}"`,
			`is_recurring: ${event.isRecurring}`,
			`macwhisper_session_id: ""`,
			`transcript: ""`,
		].join("\n");

		// Insert before the closing --- of frontmatter
		const closingIdx = content.indexOf("\n---", 1);
		if (closingIdx === -1) return content;
		return content.slice(0, closingIdx) + "\n" + reserved + content.slice(closingIdx);
	}
}
