import {App, PluginSettingTab, Setting} from "obsidian";
import type WhisperCalPlugin from "./main";

export interface WhisperCalSettings {
	timezone: string;
	refreshIntervalMinutes: number;
	noteFolderPath: string;
	noteFilenameTemplate: string;
	m365CliPath: string;
}

export const DEFAULT_SETTINGS: WhisperCalSettings = {
	timezone: "America/New_York",
	refreshIntervalMinutes: 5,
	noteFolderPath: "Meetings",
	noteFilenameTemplate: "{{date}} - {{subject}}",
	m365CliPath: "m365",
};

export class WhisperCalSettingTab extends PluginSettingTab {
	plugin: WhisperCalPlugin;

	constructor(app: App, plugin: WhisperCalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Calendar")
			.setHeading();

		new Setting(containerEl)
			.setName("Timezone")
			.setDesc("IANA timezone for displaying meeting times (e.g. America/New_York, Europe/London)")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("America/New_York")
				.setValue(this.plugin.settings.timezone)
				.onChange(async (value) => {
					this.plugin.settings.timezone = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Refresh interval (minutes)")
			.setDesc("How often to refresh the calendar view")
			.addText(text => text
				.setPlaceholder("5")
				.setValue(String(this.plugin.settings.refreshIntervalMinutes))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.refreshIntervalMinutes = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Notes folder")
			.setDesc("Vault folder where meeting notes are created")
			.addText(text => text
				.setPlaceholder("Meetings")
				.setValue(this.plugin.settings.noteFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.noteFolderPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Note filename template")
			.setDesc("Template for meeting note filenames. Available: {{date}}, {{subject}}")
			.addText(text => text
				.setPlaceholder("{{date}} - {{subject}}")
				.setValue(this.plugin.settings.noteFilenameTemplate)
				.onChange(async (value) => {
					this.plugin.settings.noteFilenameTemplate = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("m365 CLI path")
			.setDesc("Path to the m365 CLI executable")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("m365")
				.setValue(this.plugin.settings.m365CliPath)
				.onChange(async (value) => {
					this.plugin.settings.m365CliPath = value;
					await this.plugin.saveSettings();
				}));
	}
}
