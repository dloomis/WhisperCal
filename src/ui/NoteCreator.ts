import {App, TFile, TFolder} from "obsidian";
import type {CalendarEvent} from "../types";
import type {WhisperCalSettings} from "../settings";
import {formatDate, formatTime} from "../utils/time";
import {sanitizeFilename} from "../utils/sanitize";

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

		const content = this.buildNoteContent(event);
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

	private buildNoteContent(event: CalendarEvent): string {
		const tz = this.settings.timezone;
		const date = formatDate(event.startTime, tz);
		const startTime = formatTime(event.startTime, tz);
		const endTime = formatTime(event.endTime, tz);
		const location = event.location || "N/A";
		const organizer = event.organizerName
			? `${event.organizerName} <${event.organizerEmail}>`
			: event.organizerEmail;

		const attendeeList = event.attendees.length > 0
			? event.attendees.map(a => `"${a}"`).join(", ")
			: "";

		return [
			"---",
			`meeting_subject: "${event.subject}"`,
			`meeting_date: ${date}`,
			`meeting_start: "${startTime}"`,
			`meeting_end: "${endTime}"`,
			`meeting_location: "${location}"`,
			`attendees: [${attendeeList}]`,
			`organizer: "${organizer}"`,
			"tags: [meeting]",
			"---",
			"",
			"> [!info] Record",
			"> Recording functionality coming soon",
			"",
			`# ${event.subject}`,
			"",
			`**Date:** ${date} ${startTime} - ${endTime}`,
			`**Location:** ${location}`,
			`**Attendees:** ${event.attendeeCount}`,
			"",
			"---",
			"",
			"## Notes",
			"",
		].join("\n");
	}
}
