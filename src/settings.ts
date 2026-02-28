import {App, PluginSettingTab, Setting} from "obsidian";
import type WhisperCalPlugin from "./main";
import type {AuthState, CloudInstance} from "./services/AuthTypes";
import {CLOUD_INSTANCE_OPTIONS} from "./services/AuthTypes";

export interface WhisperCalSettings {
	timezone: string;
	refreshIntervalMinutes: number;
	noteFolderPath: string;
	noteFilenameTemplate: string;
	tenantId: string;
	clientId: string;
	cloudInstance: CloudInstance;
}

export const DEFAULT_SETTINGS: WhisperCalSettings = {
	timezone: "America/New_York",
	refreshIntervalMinutes: 5,
	noteFolderPath: "Meetings",
	noteFilenameTemplate: "{{date}} - {{subject}}",
	tenantId: "",
	clientId: "",
	cloudInstance: "Public",
};

export class WhisperCalSettingTab extends PluginSettingTab {
	plugin: WhisperCalPlugin;
	private authStatusEl: HTMLElement | null = null;
	private authUnsubscribe: (() => void) | null = null;

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

		// Microsoft account section
		new Setting(containerEl)
			.setName("Microsoft account")
			.setHeading();

		new Setting(containerEl)
			.setName("Tenant ID")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Directory (tenant) ID from your Azure AD app registration")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
				.setValue(this.plugin.settings.tenantId)
				.onChange(async (value) => {
					this.plugin.settings.tenantId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Client ID")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Application (client) ID from your Azure AD app registration")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
				.setValue(this.plugin.settings.clientId)
				.onChange(async (value) => {
					this.plugin.settings.clientId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Cloud instance")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Microsoft cloud environment (Public, USGov, USGovHigh, USGovDoD, China)")
			.addDropdown(dropdown => {
				for (const option of CLOUD_INSTANCE_OPTIONS) {
					dropdown.addOption(option, option);
				}
				dropdown.setValue(this.plugin.settings.cloudInstance);
				dropdown.onChange(async (value) => {
					this.plugin.settings.cloudInstance = value as CloudInstance;
					await this.plugin.saveSettings();
				});
			});

		// Auth status + actions
		this.authStatusEl = containerEl.createDiv({cls: "whisper-cal-auth-status"});
		this.renderAuthStatus(this.plugin.auth.getState());

		// Subscribe to auth state changes
		this.authUnsubscribe = this.plugin.onAuthStateChange((state) => {
			this.renderAuthStatus(state);
		});
	}

	hide(): void {
		this.authUnsubscribe?.();
		this.authUnsubscribe = null;
	}

	private renderAuthStatus(state: AuthState): void {
		if (!this.authStatusEl) return;
		this.authStatusEl.empty();

		const statusContainer = this.authStatusEl.createDiv({cls: "whisper-cal-auth-section"});

		switch (state.status) {
		case "signed-out": {
			statusContainer.createDiv({
				cls: "whisper-cal-auth-label",
				text: "Not signed in",
			});
			/* eslint-disable obsidianmd/ui/sentence-case */
			const btn = statusContainer.createEl("button", {
				cls: "whisper-cal-btn",
				text: "Sign in with Microsoft",
			});
			/* eslint-enable obsidianmd/ui/sentence-case */
			btn.addEventListener("click", () => {
				void this.plugin.auth.startDeviceCodeFlow();
			});
			break;
		}
		case "signing-in": {
			statusContainer.createDiv({
				cls: "whisper-cal-auth-label",
				text: "Sign in: enter this code in your browser",
			});
			const codeEl = statusContainer.createDiv({cls: "whisper-cal-device-code"});
			codeEl.setText(state.userCode);
			const linkEl = statusContainer.createEl("a", {
				cls: "whisper-cal-auth-link",
				text: state.verificationUri,
				href: state.verificationUri,
			});
			linkEl.setAttr("target", "_blank");
			linkEl.setAttr("rel", "noopener");
			statusContainer.createDiv({
				cls: "whisper-cal-auth-hint",
				text: "Waiting for authorization...",
			});
			const cancelBtn = statusContainer.createEl("button", {
				cls: "whisper-cal-btn whisper-cal-btn-secondary",
				text: "Cancel",
			});
			cancelBtn.addEventListener("click", () => {
				this.plugin.auth.cancelSignIn();
				this.renderAuthStatus({status: "signed-out"});
			});
			break;
		}
		case "signed-in": {
			statusContainer.createDiv({
				cls: "whisper-cal-auth-label whisper-cal-auth-success",
				text: "Signed in",
			});
			const btn = statusContainer.createEl("button", {
				cls: "whisper-cal-btn whisper-cal-btn-secondary",
				text: "Sign out",
			});
			btn.addEventListener("click", () => {
				void this.plugin.auth.signOut();
			});
			break;
		}
		case "error": {
			statusContainer.createDiv({
				cls: "whisper-cal-auth-label whisper-cal-auth-error",
				text: state.message,
			});
			const btn = statusContainer.createEl("button", {
				cls: "whisper-cal-btn",
				text: "Try again",
			});
			btn.addEventListener("click", () => {
				void this.plugin.auth.startDeviceCodeFlow();
			});
			break;
		}
		}
	}
}
