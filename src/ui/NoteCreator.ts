import {App, MarkdownView, TFile, TFolder, WorkspaceLeaf} from "obsidian";
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
		return `${this.settings.noteFolderPath}/${filename}.md`;
	}

	noteExists(event: CalendarEvent): boolean {
		const path = this.getNotePath(event);
		return this.app.vault.getAbstractFileByPath(path) instanceof TFile;
	}

	async openExistingNote(event: CalendarEvent): Promise<void> {
		const path = this.getNotePath(event);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf("tab").openFile(file);
		}
	}

	async createNote(event: CalendarEvent): Promise<void> {
		const path = this.getNotePath(event);

		// If note already exists, just open it
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.workspace.getLeaf("tab").openFile(existing);
			return;
		}

		// Ensure folder exists
		await this.ensureFolder(this.settings.noteFolderPath);

		const noteCreated = new Date();
		const content = await this.buildNoteContent(event, noteCreated);
		const file = await this.app.vault.create(path, content);
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file);
		this.setCursorToNotesSection(leaf, content);
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

	private async buildNoteContent(event: CalendarEvent, noteCreated: Date): Promise<string> {
		const template = await loadTemplate(this.app, this.settings.noteTemplatePath);
		const peopleSvc = new PeopleMatchService(this.app, this.settings.peopleFolderPath);
		const peopleMatch = peopleSvc.matchAttendees(event.attendees);
		const organizerNotePath = peopleSvc.matchOne(event.organizerName, event.organizerEmail);
		const variables = buildVariableMap(event, this.settings.timezone, peopleMatch, organizerNotePath, noteCreated);
		return applyTemplate(template, variables);
	}
}
