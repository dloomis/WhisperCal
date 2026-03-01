import {App, DropdownComponent, Notice, PluginSettingTab, Setting, requestUrl} from "obsidian";
import type WhisperCalPlugin from "./main";
import type {AuthState, CloudInstance} from "./services/AuthTypes";
import {CLOUD_INSTANCE_OPTIONS} from "./services/AuthTypes";
import {FileSuggest} from "./ui/FileSuggest";
import {FolderSuggest} from "./ui/FolderSuggest";
import {createDefaultTemplateFile} from "./services/TemplateEngine";

export interface WhisperCalSettings {
	timezone: string;
	refreshIntervalMinutes: number;
	noteFolderPath: string;
	noteFilenameTemplate: string;
	noteTemplatePath: string;
	tenantId: string;
	clientId: string;
	cloudInstance: CloudInstance;
	peopleFolderPath: string;
	recordingFolderPath: string;
	systemAudioDeviceId: string;
	transcriptionFolderPath: string;
	assemblyAiBaseUrl: string;
	assemblyAiApiKey: string;
	assemblyAiSpeechModel: string;
	transcriptionLanguage: string;
	autoTranscribe: boolean;
}

export const DEFAULT_SETTINGS: WhisperCalSettings = {
	timezone: "America/New_York",
	refreshIntervalMinutes: 5,
	noteFolderPath: "Meetings",
	noteFilenameTemplate: "{{date}} - {{subject}}",
	noteTemplatePath: "",
	tenantId: "",
	clientId: "",
	cloudInstance: "Public",
	peopleFolderPath: "",
	recordingFolderPath: "Recordings",
	systemAudioDeviceId: "",
	transcriptionFolderPath: "Transcriptions",
	assemblyAiBaseUrl: "https://api.assemblyai.com/v2",
	assemblyAiApiKey: "",
	assemblyAiSpeechModel: "universal-3-pro",
	transcriptionLanguage: "",
	autoTranscribe: false,
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

		new Setting(containerEl)
			.setName("Note template")
			.setDesc("Vault file used as a template for meeting note content. Leave empty to use the default template.")
			.addText(text => {
				text.setPlaceholder("Templates/WhisperCal Meeting.md")
					.setValue(this.plugin.settings.noteTemplatePath)
					.onChange(async (value) => {
						this.plugin.settings.noteTemplatePath = value;
						await this.plugin.saveSettings();
					});
				new FileSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("Create default template")
			.setDesc("Write the default meeting note template to a file in your vault for customization")
			.addButton(button => button
				.setButtonText("Create template file")
				.onClick(async () => {
					const path = this.plugin.settings.noteTemplatePath
						|| "Templates/WhisperCal Meeting.md";
					await createDefaultTemplateFile(this.app, path);
					if (!this.plugin.settings.noteTemplatePath) {
						this.plugin.settings.noteTemplatePath = path;
						await this.plugin.saveSettings();
						this.display();
					}
				}));

		new Setting(containerEl)
			.setName("People notes")
			.setHeading();

		new Setting(containerEl)
			.setName("People folder")
			.setDesc("Vault folder containing people notes. Matched attendees render as [[wiki links]] in meeting notes.")
			.addText(text => {
				text.setPlaceholder("People")
					.setValue(this.plugin.settings.peopleFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.peopleFolderPath = value;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		// Recording section
		new Setting(containerEl)
			.setName("Recording")
			.setHeading();

		new Setting(containerEl)
			.setName("Recordings folder")
			.setDesc("Vault folder where meeting recordings are saved")
			.addText(text => {
				text.setPlaceholder("Recordings")
					.setValue(this.plugin.settings.recordingFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.recordingFolderPath = value;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("System audio device")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Virtual audio device (e.g. BlackHole) to capture system audio alongside your microphone. Leave as \"None\" for mic-only recording.")
			.addDropdown(dropdown => {
				dropdown.addOption("", "None (microphone only)");
				dropdown.setValue(this.plugin.settings.systemAudioDeviceId);
				dropdown.onChange(async (value) => {
					this.plugin.settings.systemAudioDeviceId = value;
					await this.plugin.saveSettings();
				});
				void this.populateAudioDevices(dropdown);
			});

		// Transcription section
		new Setting(containerEl)
			.setName("Transcription")
			.setHeading();

		new Setting(containerEl)
			.setName("Transcriptions folder")
			.setDesc("Vault folder where transcript files are saved")
			.addText(text => {
				text.setPlaceholder("Transcriptions")
					.setValue(this.plugin.settings.transcriptionFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.transcriptionFolderPath = value;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("API endpoint")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("AssemblyAI API base URL")
			.addText(text => text
				.setPlaceholder("https://api.assemblyai.com/v2")
				.setValue(this.plugin.settings.assemblyAiBaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.assemblyAiBaseUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("API key")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("AssemblyAI API key for cloud transcription with speaker diarization")
			.addText(text => {
				text.setPlaceholder("Enter your API key")
					.setValue(this.plugin.settings.assemblyAiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.assemblyAiApiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		let speechModelDropdown: DropdownComponent;
		new Setting(containerEl)
			.setName("Speech model")
			.setDesc("Speech recognition model to use for transcription")
			.addDropdown(dropdown => {
				speechModelDropdown = dropdown;
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				dropdown.addOption("universal-3-pro", "universal-3-pro");
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				dropdown.addOption("universal-2", "universal-2");
				dropdown.setValue(this.plugin.settings.assemblyAiSpeechModel);
				dropdown.onChange(async (value) => {
					this.plugin.settings.assemblyAiSpeechModel = value;
					await this.plugin.saveSettings();
				});
			});

		const testKeySetting = new Setting(containerEl)
			.setName("Test API key")
			.setDesc("Verify your API key is valid and detect available speech models")
			.addButton(button => button
				.setButtonText("Test API key")
				.onClick(async () => {
					await this.testAssemblyAiKey(testKeySetting, speechModelDropdown);
				}));

		new Setting(containerEl)
			.setName("Language")
			.setDesc("Language code for transcription (leave empty for auto-detect)")
			.addText(text => text
				.setPlaceholder("Auto-detect")
				.setValue(this.plugin.settings.transcriptionLanguage)
				.onChange(async (value) => {
					this.plugin.settings.transcriptionLanguage = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Auto-transcribe")
			.setDesc("Automatically transcribe recordings when they finish saving")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoTranscribe)
				.onChange(async (value) => {
					this.plugin.settings.autoTranscribe = value;
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

	private async testAssemblyAiKey(setting: Setting, modelDropdown: DropdownComponent): Promise<void> {
		const apiKey = this.plugin.settings.assemblyAiApiKey;
		if (!apiKey) {
			new Notice("API key is empty");
			return;
		}

		setting.setDesc("Testing...");
		const baseUrl = this.plugin.settings.assemblyAiBaseUrl.replace(/\/+$/, "");

		try {
			await requestUrl({
				url: `${baseUrl}/transcript?limit=1`,
				method: "GET",
				headers: {
					"Authorization": apiKey,
				},
			});
		} catch {
			setting.setDesc("API key test failed — check your key and endpoint");
			new Notice("API key test failed");
			return;
		}

		// Discover available speech models by sending an invalid value and parsing the error
		const models = await this.discoverSpeechModels(baseUrl, apiKey);
		if (models.length > 0) {
			const selectEl = modelDropdown.selectEl;
			selectEl.empty();
			for (const id of models) {
				modelDropdown.addOption(id, id);
			}
			// Preserve current selection if still valid, otherwise pick first
			const current = this.plugin.settings.assemblyAiSpeechModel;
			if (models.includes(current)) {
				modelDropdown.setValue(current);
			} else {
				const first = models[0] as string;
				modelDropdown.setValue(first);
				this.plugin.settings.assemblyAiSpeechModel = first;
				await this.plugin.saveSettings();
			}
			const modelList = models.join(", ");
			setting.setDesc(`API key valid — models: ${modelList}`);
			new Notice(`API key valid — ${models.length} model(s): ${modelList}`);
		} else {
			setting.setDesc("API key is valid");
			new Notice("API key is valid");
		}
	}

	private async discoverSpeechModels(baseUrl: string, apiKey: string): Promise<string[]> {
		try {
			// eslint-disable-next-line no-restricted-globals
			const response = await fetch(`${baseUrl}/transcript`, {
				method: "POST",
				headers: {
					"Authorization": apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					audio_url: "https://invalid",
					speech_models: ["__probe__"],
				}),
			});

			if (response.status === 400) {
				const data = await response.json() as {error?: string};
				if (typeof data.error === "string") {
					// Parse model names from error like: "...one or more of: \"universal-3-pro\", \"universal-2\""
					const matches = [...data.error.matchAll(/"([^"]+)"/g)];
					const models = matches.map(m => m[1] as string).filter(m => m !== "speech_models");
					if (models.length > 0) return models;
				}
			}
		} catch {
			// Discovery is best-effort
		}
		return [];
	}

	private async populateAudioDevices(dropdown: DropdownComponent): Promise<void> {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			const audioInputs = devices.filter(d => d.kind === "audioinput");
			for (const device of audioInputs) {
				const label = device.label || `Audio input (${device.deviceId.substring(0, 8)})`;
				dropdown.addOption(device.deviceId, label);
			}
			// Re-set value so saved selection is shown after async load
			dropdown.setValue(this.plugin.settings.systemAudioDeviceId);
		} catch {
			// Device enumeration unavailable
		}
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
