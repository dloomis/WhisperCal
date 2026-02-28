import {App, TFile, TFolder} from "obsidian";
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

		const content = await this.buildNoteContent(event);
		const file = await this.app.vault.create(path, content);
		await this.app.workspace.getLeaf("tab").openFile(file);
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

	private async buildNoteContent(event: CalendarEvent): Promise<string> {
		const template = await loadTemplate(this.app, this.settings.noteTemplatePath);
		const peopleSvc = new PeopleMatchService(this.app, this.settings.peopleFolderPath);
		const peopleMatch = peopleSvc.matchAttendees(event.attendees);
		const organizerNotePath = peopleSvc.matchOne(event.organizerName, event.organizerEmail);
		const variables = buildVariableMap(event, this.settings.timezone, peopleMatch, organizerNotePath);
		return applyTemplate(template, variables);
	}
}
