import {App, Modal, PluginSettingTab, Setting, requestUrl} from "obsidian";
import type WhisperCalPlugin from "./main";
import type {AuthState, CloudInstance} from "./services/AuthTypes";
import {CLOUD_INSTANCE_OPTIONS} from "./services/AuthTypes";
import type {CalendarProviderType} from "./types";
import {MACWHISPER_DB_PATH} from "./constants";
import {FileSuggest} from "./ui/FileSuggest";
import {FolderSuggest} from "./ui/FolderSuggest";
import type {PeopleSearchResult} from "./services/PeopleSearchProvider";

export interface ImportantOrganizer {
	name: string;
	email: string;
}

export interface WhisperCalSettings {
	calendarProvider: CalendarProviderType;
	timezone: string;
	refreshIntervalMinutes: number;
	noteFolderPath: string;
	noteFilenameTemplate: string;
	noteTemplatePath: string;
	// Microsoft-specific
	tenantId: string;
	clientId: string;
	cloudInstance: CloudInstance;
	// Google-specific
	googleClientId: string;
	googleClientSecret: string;
	// Shared
	peopleFolderPath: string;
	transcriptFolderPath: string;
	unscheduledSubject: string;
	recordingWindowMinutes: number;
	unlinkedLookbackDays: number;
	speakerTaggingPromptPath: string;
	summarizerPromptPath: string;
	researchPromptPath: string;
	microphoneUser: string;
	llmEnabled: boolean;
	llmCli: string;
	llmExtraFlags: string;
	speakerTagModel: string;
	summarizerModel: string;
	researchModel: string;
	llmTimeoutMinutes: number;
	llmMaxConcurrent: number;
	llmDebugMode: boolean;
	autoSummarizeAfterTagging: boolean;
	showAllDayEvents: boolean;
	importantOrganizers: ImportantOrganizer[];
	cacheFutureDays: number;
	cacheRetentionDays: number;
	timeFormat: "auto" | "12h" | "24h";
	recordingSource: "macwhisper" | "api";
	recordingApiBaseUrl: string;
}

export const DEFAULT_SETTINGS: WhisperCalSettings = {
	calendarProvider: "microsoft",
	timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/New_York",
	refreshIntervalMinutes: 5,
	noteFolderPath: "Meetings",
	noteFilenameTemplate: "{{date}} - {{subject}}",
	noteTemplatePath: "",
	tenantId: "",
	clientId: "",
	cloudInstance: "Public",
	googleClientId: "",
	googleClientSecret: "",
	peopleFolderPath: "",
	transcriptFolderPath: "Transcripts",
	unscheduledSubject: "Unscheduled Meeting",
	recordingWindowMinutes: 15,
	unlinkedLookbackDays: 30,
	speakerTaggingPromptPath: "Prompts/Speaker Auto-Tag Prompt.md",
	summarizerPromptPath: "Prompts/Meeting Transcript Summarizer Prompt.md",
	researchPromptPath: "Prompts/Meeting Research Prompt.md",
	microphoneUser: "",
	llmEnabled: false,
	llmCli: "claude",
	llmExtraFlags: "--dangerously-skip-permissions",
	speakerTagModel: "",
	summarizerModel: "",
	researchModel: "",
	llmTimeoutMinutes: 5,
	llmMaxConcurrent: 2,
	llmDebugMode: false,
	autoSummarizeAfterTagging: false,
	showAllDayEvents: false,
	importantOrganizers: [],
	cacheFutureDays: 5,
	cacheRetentionDays: 30,
	timeFormat: "auto",
	recordingSource: "macwhisper",
	recordingApiBaseUrl: "",
};

class LlmConsentModal extends Modal {
	private resolve: ((accepted: boolean) => void) | null = null;
	private accepted = false;

	prompt(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		contentEl.createEl("h2", {text: "Enable LLM features?"});
		contentEl.createEl("p", {
			text: "Speaker tagging and summarization send meeting transcripts and note content to a cloud LLM provider. " +
				"This may include sensitive or controlled information.",
		});
		contentEl.createEl("p", {
			cls: "mod-warning",
			text: "Only enable this if you are authorized to send this data to external services.",
		});
		const btnRow = contentEl.createDiv({cls: "modal-button-container"});
		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());
		/* eslint-disable obsidianmd/ui/sentence-case */
		const acceptBtn = btnRow.createEl("button", {
			cls: "mod-cta",
			text: "I understand, enable LLM features",
		});
		/* eslint-enable obsidianmd/ui/sentence-case */
		acceptBtn.addEventListener("click", () => {
			this.accepted = true;
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(this.accepted);
				this.resolve = null;
			}
		}, 0);
	}
}

export class WhisperCalSettingTab extends PluginSettingTab {
	plugin: WhisperCalPlugin;
	private authStatusEl: HTMLElement | null = null;
	private authUnsubscribe: (() => void) | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private searchTimer: number | null = null;

	constructor(app: App, plugin: WhisperCalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Debounced save — batches rapid text input changes into a single save after 500ms of inactivity. */
	private debouncedSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.saveSettings();
		}, 500);
	}

	display(): void {
		// Unsubscribe any previous auth listener to prevent stacking on re-render
		this.authUnsubscribe?.();
		this.authUnsubscribe = null;

		const {containerEl} = this;
		containerEl.empty();
		containerEl.addClass("whisper-cal-settings");

		containerEl.createEl("div", {
			cls: "whisper-cal-settings-version",
			text: `v${this.plugin.manifest.version}`,
		});

		new Setting(containerEl)
			.setName("Notes")
			.setHeading();

		new Setting(containerEl)
			.setName("People folder")
			.setDesc("Vault folder containing people notes. Matched attendees render as [[wiki links]] in meeting notes.")
			.addText(text => {
				text.setPlaceholder("People")
					.setValue(this.plugin.settings.peopleFolderPath)
					.onChange((value) => {
						this.plugin.settings.peopleFolderPath = value;
						this.debouncedSave();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("Notes folder")
			.setDesc("Vault folder where meeting notes are created")
			.addText(text => {
				text.setPlaceholder("Meetings")
					.setValue(this.plugin.settings.noteFolderPath)
					.onChange((value) => {
						this.plugin.settings.noteFolderPath = value;
						this.debouncedSave();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("Transcripts folder")
			.setDesc("Vault folder where transcript files are created when linking recordings")
			.addText(text => {
				text.setPlaceholder("Transcripts")
					.setValue(this.plugin.settings.transcriptFolderPath)
					.onChange((value) => {
						this.plugin.settings.transcriptFolderPath = value;
						this.debouncedSave();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("Note filename template")
			.setDesc("Template for meeting note filenames. Available: {{date}}, {{subject}}")
			.addText(text => text
				.setPlaceholder("{{date}} - {{subject}}")
				.setValue(this.plugin.settings.noteFilenameTemplate)
				.onChange((value) => {
					this.plugin.settings.noteFilenameTemplate = value;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName("Unscheduled note subject")
			.setDesc("Subject used for ad-hoc meeting notes not tied to a calendar event")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("Unscheduled Meeting")
				.setValue(this.plugin.settings.unscheduledSubject)
				.onChange((value) => {
					this.plugin.settings.unscheduledSubject = value;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName("Note template")
			.setDesc("Vault file used as a template for meeting note content. Copy the sample template from the plugin's samples/ folder into your vault and set the path here.")
			.addText(text => {
				text.setPlaceholder("Templates/WhisperCal Meeting.md")
					.setValue(this.plugin.settings.noteTemplatePath)
					.onChange((value) => {
						this.plugin.settings.noteTemplatePath = value;
						this.debouncedSave();
					});
				new FileSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("Calendar")
			.setHeading();

		new Setting(containerEl)
			.setName("Calendar provider")
			.setDesc("Which calendar service to connect to")
			.addDropdown(dropdown => {
				dropdown.addOption("microsoft", "Microsoft 365");
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- product names
				dropdown.addOption("google", "Google Calendar");
				dropdown.setValue(this.plugin.settings.calendarProvider);
				dropdown.onChange(async (value) => {
					this.plugin.settings.calendarProvider = value as CalendarProviderType;
					await this.plugin.saveSettings();
					this.display(); // Re-render to swap auth sections
				});
			});

		// Provider-specific credential sections + auth status (colocated with provider dropdown)
		if (this.plugin.settings.calendarProvider === "microsoft") {
			this.renderMicrosoftAuthSettings(containerEl);
		} else {
			this.renderGoogleAuthSettings(containerEl);
		}

		this.authStatusEl = containerEl.createDiv({cls: "whisper-cal-auth-status"});
		this.renderAuthStatus(this.plugin.auth.getState());
		this.authUnsubscribe = this.plugin.onAuthStateChange((state) => {
			this.renderAuthStatus(state);
		});

		// General calendar settings (apply to both providers)
		new Setting(containerEl)
			.setName("Timezone")
			.setDesc("IANA timezone for displaying meeting times (e.g. America/New_York, Europe/London)")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("America/New_York")
				.setValue(this.plugin.settings.timezone)
				.onChange((value) => {
					try {
						Intl.DateTimeFormat(undefined, {timeZone: value});
					} catch {
						return; // Ignore invalid timezone — keep previous value
					}
					this.plugin.settings.timezone = value;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName("Time format")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("How meeting times are displayed: 12-hour (9:00 AM), 24-hour (09:00), or auto-detect from system")
			.addDropdown(dropdown => {
				dropdown.addOption("auto", "Auto");
				dropdown.addOption("12h", "12-hour");
				dropdown.addOption("24h", "24-hour");
				dropdown.setValue(this.plugin.settings.timeFormat);
				dropdown.onChange(async (value) => {
					this.plugin.settings.timeFormat = value as "auto" | "12h" | "24h";
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Show all-day events")
			.setDesc("Display all-day events in the calendar view")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showAllDayEvents)
				.onChange(async (value) => {
					this.plugin.settings.showAllDayEvents = value;
					await this.plugin.saveSettings();
				}));

		this.renderImportantOrganizers(containerEl);

		new Setting(containerEl)
			.setName("Refresh interval (minutes)")
			.setDesc("How often to refresh the calendar view")
			.addText(text => text
				.setPlaceholder("5")
				.setValue(String(this.plugin.settings.refreshIntervalMinutes))
				.onChange((value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.refreshIntervalMinutes = num;
						this.debouncedSave();
					}
				}));

		new Setting(containerEl)
			.setName("Cache future days")
			.setDesc("Number of upcoming days to pre-fetch for offline access")
			.addText(text => text
				.setPlaceholder("5")
				.setValue(String(this.plugin.settings.cacheFutureDays))
				.onChange((value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 0) {
						this.plugin.settings.cacheFutureDays = num;
						this.debouncedSave();
					}
				}));

		new Setting(containerEl)
			.setName("Cache retention (days)")
			.setDesc("How many days of past calendar data to keep in the local cache")
			.addText(text => text
				.setPlaceholder("30")
				.setValue(String(this.plugin.settings.cacheRetentionDays))
				.onChange((value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.cacheRetentionDays = num;
						this.debouncedSave();
					}
				}));

		new Setting(containerEl)
			.setName("Recording")
			.setHeading();

		/* eslint-disable obsidianmd/ui/sentence-case */
		const macwhisperSettings = containerEl.createDiv();
		const apiSettings = containerEl.createDiv();
		const updateRecordingVisibility = () => {
			const isMacWhisper = this.plugin.settings.recordingSource === "macwhisper";
			macwhisperSettings.toggle(isMacWhisper);
			apiSettings.toggle(!isMacWhisper);
		};

		const sourceSetting = new Setting(containerEl)
			.setName("Source")
			.setDesc("Choose how meeting recordings are captured")
			.addDropdown(dropdown => dropdown
				.addOption("macwhisper", "MacWhisper")
				.addOption("api", "Recording API")
				.setValue(this.plugin.settings.recordingSource)
				.onChange((value: string) => {
					this.plugin.settings.recordingSource = value as "macwhisper" | "api";
					this.debouncedSave();
					updateRecordingVisibility();
				}));
		// Move Source dropdown above the sub-setting containers
		containerEl.insertBefore(sourceSetting.settingEl, macwhisperSettings);
		/* eslint-enable obsidianmd/ui/sentence-case */

		// MacWhisper sub-settings
		new Setting(macwhisperSettings)
			.setName("Database path")
			.setDesc(MACWHISPER_DB_PATH)
			.setDisabled(true);

		new Setting(macwhisperSettings)
			.setName("Recording match window (minutes)")
			.setDesc("How close a recording start must be to the scheduled meeting time to be suggested for linking")
			.addText(text => text
				.setPlaceholder("10")
				.setValue(String(this.plugin.settings.recordingWindowMinutes))
				.onChange((value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.recordingWindowMinutes = num;
						this.debouncedSave();
					}
				}));

		new Setting(macwhisperSettings)
			.setName("Unlinked lookback (days)")
			.setDesc("How far back to check for unlinked recordings")
			.addText(text => text
				.setPlaceholder("30")
				.setValue(String(this.plugin.settings.unlinkedLookbackDays))
				.onChange((value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.unlinkedLookbackDays = num;
						this.debouncedSave();
					}
				}));

		// Recording API sub-settings
		new Setting(apiSettings)
			.setName("Base URL")
			.setDesc("REST API base URL (e.g. http://127.0.0.1:8080/api/v1). Expects /health, /start, /stop, /status endpoints.")
			.addText(text => text
				.setPlaceholder("http://127.0.0.1:8080/api/v1")
				.setValue(this.plugin.settings.recordingApiBaseUrl)
				.onChange((value) => {
					this.plugin.settings.recordingApiBaseUrl = value.replace(/\/+$/, "");
					this.debouncedSave();
				}));

		updateRecordingVisibility();

		/* eslint-disable obsidianmd/ui/sentence-case */
		new Setting(containerEl)
			.setName("LLM")
			.setHeading();

		new Setting(containerEl)
			.setName("Enable LLM features")
			.setDesc("Allow speaker tagging and summarization via a cloud LLM. Enabling this may send meeting content to external services.")
			.addToggle(toggle => {
				let handling = false;
				toggle.setValue(this.plugin.settings.llmEnabled);
				toggle.onChange(async (value) => {
					if (handling) return;
					handling = true;
					try {
						if (value) {
							toggle.setValue(false);
							const accepted = await new LlmConsentModal(this.app).prompt();
							if (accepted) {
								this.plugin.settings.llmEnabled = true;
								toggle.setValue(true);
								await this.plugin.saveSettings();
							}
						} else {
							this.plugin.settings.llmEnabled = false;
							await this.plugin.saveSettings();
						}
					} finally {
						handling = false;
					}
				});
			});

		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc("Open LLM commands in a Terminal window instead of running in the background")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.llmDebugMode)
				.onChange(async (value) => {
					this.plugin.settings.llmDebugMode = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("CLI command")
			.setDesc("Command used to invoke the LLM (default: claude)")
			.addText(text => text
				.setPlaceholder("claude")
				.setValue(this.plugin.settings.llmCli)
				.onChange((value) => {
					this.plugin.settings.llmCli = value.trim() || "claude";
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName("Additional flags")
			.setDesc("Extra CLI flags appended to the LLM command. " +
				"⚠️ The default --dangerously-skip-permissions is required for " +
				"non-interactive LLM usage — removing it will break speaker tagging " +
				"and summarization.")
			.addText(text => text
				.setPlaceholder("--dangerously-skip-permissions")
				.setValue(this.plugin.settings.llmExtraFlags)
				.onChange((value) => {
					this.plugin.settings.llmExtraFlags = value;
					this.debouncedSave();
				}));

		// Per-prompt settings: each prompt has a file path + model selector
		const modelSelects: HTMLSelectElement[] = [];

		const addPromptSetting = (
			name: string,
			desc: string,
			placeholder: string,
			pathKey: "speakerTaggingPromptPath" | "summarizerPromptPath" | "researchPromptPath",
			modelKey: "speakerTagModel" | "summarizerModel" | "researchModel",
		) => {
			new Setting(containerEl)
				.setName(`${name} prompt`)
				.setDesc(desc)
				.addText(text => {
					text.setPlaceholder(placeholder)
						.setValue(this.plugin.settings[pathKey])
						.onChange((value) => {
							this.plugin.settings[pathKey] = value;
							this.debouncedSave();
						});
					new FileSuggest(this.app, text.inputEl);
				});

			new Setting(containerEl)
				.setName(`${name} model`)
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setDesc(`Claude model for ${name.toLowerCase()}. Set ANTHROPIC_API_KEY to load available models.`)
				.addDropdown(dropdown => {
					modelSelects.push(dropdown.selectEl);
					dropdown.addOption("", "Default");
					const current = this.plugin.settings[modelKey];
					if (current) {
						dropdown.addOption(current, current);
					}
					dropdown.setValue(current);
					dropdown.onChange(async (value) => {
						this.plugin.settings[modelKey] = value;
						await this.plugin.saveSettings();
					});
				});
		};

		addPromptSetting(
			"Speaker tagging",
			"Vault-relative or absolute path to the Claude Code prompt file for tagging speakers (e.g. Prompts/Speaker Tagging.md)",
			"Prompts/Speaker Tagging.md",
			"speakerTaggingPromptPath",
			"speakerTagModel",
		);
		addPromptSetting(
			"Summarizer",
			"Vault-relative or absolute path to the Claude Code prompt file for summarizing transcripts (e.g. Prompts/Meeting Summarizer.md)",
			"Prompts/Meeting Summarizer.md",
			"summarizerPromptPath",
			"summarizerModel",
		);
		addPromptSetting(
			"Research",
			"Vault-relative or absolute path to the Claude Code prompt file for meeting research (e.g. Prompts/Meeting Research.md)",
			"Prompts/Meeting Research.md",
			"researchPromptPath",
			"researchModel",
		);

		new Setting(containerEl)
			.setName("Microphone user")
			.setDesc("Your full name as it appears in meeting notes — passed to the LLM to identify your voice in transcripts")
			.addText(text => text
				.setPlaceholder("Full name")
				.setValue(this.plugin.settings.microphoneUser)
				.onChange((value) => {
					this.plugin.settings.microphoneUser = value;
					this.debouncedSave();
				}));

		// Populate all model dropdowns once the API responds
		void this.fetchAnthropicModels().then(models => {
			if (models.length === 0) return;
			const modelKeys: ("speakerTagModel" | "summarizerModel" | "researchModel")[] =
				["speakerTagModel", "summarizerModel", "researchModel"];
			for (let i = 0; i < modelSelects.length; i++) {
				const sel = modelSelects[i]!;
				const current = this.plugin.settings[modelKeys[i]!];
				sel.replaceChildren();
				sel.add(new Option("Default", ""));
				for (const m of models) {
					sel.add(new Option(m.display_name, m.id));
				}
				sel.value = current;
			}
		});

		/* eslint-enable obsidianmd/ui/sentence-case */

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("LLM timeout (minutes)")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Kill the LLM process if it runs longer than this (0 = no timeout)")
			.addText(text => text
				.setValue(String(this.plugin.settings.llmTimeoutMinutes))
				.onChange((value) => {
					const n = parseInt(value, 10);
					if (!isNaN(n) && n >= 0) {
						this.plugin.settings.llmTimeoutMinutes = n;
						this.debouncedSave();
					}
				}));

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("Max concurrent LLM processes")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Maximum number of LLM processes that can run simultaneously")
			.addText(text => text
				.setValue(String(this.plugin.settings.llmMaxConcurrent))
				.onChange((value) => {
					const n = parseInt(value, 10);
					if (!isNaN(n) && n >= 1) {
						this.plugin.settings.llmMaxConcurrent = n;
						this.debouncedSave();
					}
				}));

		new Setting(containerEl)
			.setName("Auto-summarize after tagging")
			.setDesc("Automatically start summarization after speaker tagging completes")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSummarizeAfterTagging)
				.onChange(async (value) => {
					this.plugin.settings.autoSummarizeAfterTagging = value;
					await this.plugin.saveSettings();
				}));
	}

	hide(): void {
		this.authUnsubscribe?.();
		this.authUnsubscribe = null;
		if (this.searchTimer !== null) {
			window.clearTimeout(this.searchTimer);
			this.searchTimer = null;
		}
		// Flush any pending debounced save so settings aren't lost
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			void this.plugin.saveSettings();
		}
	}

	private async fetchAnthropicModels(): Promise<{id: string; display_name: string}[]> {
		try {
			const apiKey = process.env["ANTHROPIC_API_KEY"];
			if (!apiKey) return [];

			const response = await requestUrl({
				url: "https://api.anthropic.com/v1/models?limit=100",
				method: "GET",
				headers: {
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
				},
			});

			interface ModelEntry { id: string; display_name?: string }
			const data = response.json as {data?: ModelEntry[]};
			return (data.data ?? [])
				.filter(m => m.id.startsWith("claude-"))
				.map(m => ({id: m.id, display_name: m.display_name ?? m.id}))
				.sort((a, b) => a.display_name.localeCompare(b.display_name));
		} catch {
			return [];
		}
	}

	private renderMicrosoftAuthSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Microsoft account")
			.setHeading();

		new Setting(containerEl)
			.setName("Tenant ID")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Directory (tenant) ID from Azure AD. Leave empty to auto-detect from your account.")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
				.setValue(this.plugin.settings.tenantId)
				.onChange((value) => {
					this.plugin.settings.tenantId = value;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName("Client ID")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Application (client) ID from your Azure AD app registration")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
				.setValue(this.plugin.settings.clientId)
				.onChange((value) => {
					this.plugin.settings.clientId = value;
					this.debouncedSave();
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
	}

	private renderGoogleAuthSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Google account")
			.setHeading();

		/* eslint-disable obsidianmd/ui/sentence-case */
		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("OAuth client ID from your Google Cloud Console desktop app credentials")
			.addText(text => text
				.setPlaceholder("xxxxxxxxxxxx.apps.googleusercontent.com")
				.setValue(this.plugin.settings.googleClientId)
				.onChange((value) => {
					this.plugin.settings.googleClientId = value;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("OAuth client secret from your Google Cloud Console desktop app credentials")
			.addText(text => {
				text.setPlaceholder("GOCSPX-xxxxxxxxxxxxxxxxxxxx")
					.setValue(this.plugin.settings.googleClientSecret)
					.onChange((value) => {
						this.plugin.settings.googleClientSecret = value;
						this.debouncedSave();
					});
				text.inputEl.type = "password";
			});
		/* eslint-enable obsidianmd/ui/sentence-case */
	}

	private renderImportantOrganizers(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName("Important organizers")
			.setDesc("Meetings organized by these people show an alert icon in the gutter");

		const settingEl = setting.settingEl;
		settingEl.addClass("whisper-cal-important-organizers-setting");

		const chipField = settingEl.createDiv({cls: "whisper-cal-chip-field"});
		const input = chipField.createEl("input", {
			type: "text",
			cls: "whisper-cal-chip-input",
			attr: {placeholder: "Search people\u2026"},
		});

		const suggestionsEl = settingEl.createDiv({cls: "whisper-cal-email-suggestions"});
		const errorEl = settingEl.createDiv({cls: "whisper-cal-email-error"});

		const renderChips = () => {
			chipField.querySelectorAll(".whisper-cal-chip").forEach(el => el.remove());
			for (const org of this.plugin.settings.importantOrganizers) {
				const chip = chipField.createDiv({cls: "whisper-cal-chip"});
				chip.createSpan({cls: "whisper-cal-chip-label", text: org.name || org.email});
				const removeBtn = chip.createSpan({
					cls: "whisper-cal-chip-remove",
					attr: {"aria-label": `Remove ${org.name || org.email}`},
				});
				removeBtn.setText("\u00D7");
				removeBtn.addEventListener("click", () => {
					this.plugin.settings.importantOrganizers =
						this.plugin.settings.importantOrganizers.filter(o => o.email !== org.email);
					void this.plugin.saveSettings();
					renderChips();
				});
				chipField.insertBefore(chip, input);
			}
			input.placeholder = this.plugin.settings.importantOrganizers.length > 0
				? "" : "Search people\u2026";
		};

		renderChips();
		chipField.addEventListener("click", () => input.focus());

		// People search via provider-agnostic PeopleSearchProvider
		let selectedIndex = -1;
		let suggestions: PeopleSearchResult[] = [];

		const renderSuggestions = () => {
			suggestionsEl.empty();
			if (suggestions.length === 0) {
				suggestionsEl.hide();
				return;
			}
			suggestionsEl.show();
			for (let i = 0; i < suggestions.length; i++) {
				const s = suggestions[i]!;
				const item = suggestionsEl.createDiv({
					cls: `whisper-cal-email-suggestion${i === selectedIndex ? " is-selected" : ""}`,
				});
				const initials = s.name
					.split(/\s+/)
					.filter(Boolean)
					.map(w => w[0]!.toUpperCase())
					.slice(0, 2)
					.join("");
				item.createDiv({cls: "whisper-cal-suggestion-avatar", text: initials});
				const textCol = item.createDiv({cls: "whisper-cal-suggestion-text"});
				textCol.createDiv({cls: "whisper-cal-email-suggestion-name", text: s.name || s.email});
				textCol.createDiv({cls: "whisper-cal-email-suggestion-email", text: s.email});
				item.addEventListener("mousedown", (e) => {
					e.preventDefault();
					pickSuggestion(s);
				});
			}
		};

		const pickSuggestion = (s: PeopleSearchResult) => {
			const exists = this.plugin.settings.importantOrganizers.some(o => o.email === s.email);
			if (!exists) {
				this.plugin.settings.importantOrganizers.push({name: s.name, email: s.email});
				void this.plugin.saveSettings();
			}
			input.value = "";
			suggestions = [];
			selectedIndex = -1;
			renderSuggestions();
			renderChips();
			input.focus();
		};

		const searchPeople = async (query: string) => {
			if (query.length < 2) {
				suggestions = [];
				selectedIndex = -1;
				renderSuggestions();
				return;
			}
			try {
				const alreadyAdded = new Set(
					this.plugin.settings.importantOrganizers.map(o => o.email),
				);
				const results = await this.plugin.peopleSearch.search(query);
				suggestions = results.filter(s => !alreadyAdded.has(s.email));
				selectedIndex = -1;
				renderSuggestions();
			} catch {
				// Search failed — silently ignore
			}
		};

		input.addEventListener("input", () => {
			if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
			errorEl.setText("");
			const query = input.value.trim();
			this.searchTimer = window.setTimeout(() => void searchPeople(query), 300);
		});

		input.addEventListener("keydown", (e) => {
			if (suggestions.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
					renderSuggestions();
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					selectedIndex = Math.max(selectedIndex - 1, -1);
					renderSuggestions();
					return;
				}
				if (e.key === "Enter" && selectedIndex >= 0) {
					e.preventDefault();
					pickSuggestion(suggestions[selectedIndex]!);
					return;
				}
				if (e.key === "Escape") {
					suggestions = [];
					selectedIndex = -1;
					renderSuggestions();
					return;
				}
			}
			if (e.key === "Backspace" && input.value === "" && this.plugin.settings.importantOrganizers.length > 0) {
				this.plugin.settings.importantOrganizers.pop();
				void this.plugin.saveSettings();
				renderChips();
			}
			if (e.key === "Enter" && selectedIndex < 0) {
				e.preventDefault();
				const value = input.value.trim().toLowerCase();
				if (!value) return;
				const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
				if (!emailRegex.test(value)) {
					errorEl.setText("Invalid email address");
					return;
				}
				if (this.plugin.settings.importantOrganizers.some(o => o.email === value)) {
					errorEl.setText("Already added");
					return;
				}
				this.plugin.settings.importantOrganizers.push({name: value, email: value});
				void this.plugin.saveSettings();
				input.value = "";
				suggestions = [];
				renderSuggestions();
				renderChips();
			}
		});

		input.addEventListener("blur", () => {
			window.setTimeout(() => {
				suggestions = [];
				selectedIndex = -1;
				renderSuggestions();
			}, 200);
		});
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
			const btn = statusContainer.createEl("button", {
				cls: "whisper-cal-btn",
				text: "Sign in",
			});
			btn.addEventListener("click", () => {
				void this.plugin.auth.startSignIn();
			});
			break;
		}
		case "signing-in": {
			statusContainer.createDiv({
				cls: "whisper-cal-auth-label",
				text: state.message ?? "Signing in\u2026",
			});
			statusContainer.createDiv({
				cls: "whisper-cal-auth-hint",
				text: "Waiting for authorization\u2026",
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
				void this.plugin.auth.startSignIn();
			});
			break;
		}
		}
	}
}
