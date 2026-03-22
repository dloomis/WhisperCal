import {App, PluginSettingTab, Setting, requestUrl} from "obsidian";
import type WhisperCalPlugin from "./main";
import type {AuthState, CloudInstance} from "./services/AuthTypes";
import {CLOUD_INSTANCE_OPTIONS, CLOUD_ENDPOINTS} from "./services/AuthTypes";
import {MACWHISPER_DB_PATH} from "./constants";
import {FileSuggest} from "./ui/FileSuggest";
import {FolderSuggest} from "./ui/FolderSuggest";

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
	transcriptFolderPath: string;
	unscheduledSubject: string;
	recordingWindowMinutes: number;
	unlinkedLookbackDays: number;
	speakerTaggingPromptPath: string;
	summarizerPromptPath: string;
	microphoneUser: string;
	llmCli: string;
	llmExtraFlags: string;
	llmTimeoutMinutes: number;
	llmMaxConcurrent: number;
	autoSummarizeAfterTagging: boolean;
	showAllDayEvents: boolean;
	importantOrganizerEmails: string[];
	cacheFutureDays: number;
	cacheRetentionDays: number;
	deviceLoginUrl: string;
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
	transcriptFolderPath: "Transcripts",
	unscheduledSubject: "Unscheduled Meeting",
	recordingWindowMinutes: 15,
	unlinkedLookbackDays: 30,
	speakerTaggingPromptPath: "",
	summarizerPromptPath: "",
	microphoneUser: "",
	llmCli: "claude",
	llmExtraFlags: "--dangerously-skip-permissions",
	llmTimeoutMinutes: 5,
	llmMaxConcurrent: 2,
	autoSummarizeAfterTagging: false,
	showAllDayEvents: false,
	importantOrganizerEmails: [],
	cacheFutureDays: 5,
	cacheRetentionDays: 30,
	deviceLoginUrl: "",
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
					.onChange(async (value) => {
						this.plugin.settings.peopleFolderPath = value;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("Notes folder")
			.setDesc("Vault folder where meeting notes are created")
			.addText(text => {
				text.setPlaceholder("Meetings")
					.setValue(this.plugin.settings.noteFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.noteFolderPath = value;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("Transcripts folder")
			.setDesc("Vault folder where transcript files are created when linking recordings")
			.addText(text => {
				text.setPlaceholder("Transcripts")
					.setValue(this.plugin.settings.transcriptFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.transcriptFolderPath = value;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

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
			.setName("Unscheduled note subject")
			.setDesc("Subject used for ad-hoc meeting notes not tied to a calendar event")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("Unscheduled Meeting")
				.setValue(this.plugin.settings.unscheduledSubject)
				.onChange(async (value) => {
					this.plugin.settings.unscheduledSubject = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Note template")
			.setDesc("Vault file used as a template for meeting note content. Copy the sample template from the plugin's samples/ folder into your vault and set the path here.")
			.addText(text => {
				text.setPlaceholder("Templates/WhisperCal Meeting.md")
					.setValue(this.plugin.settings.noteTemplatePath)
					.onChange(async (value) => {
						this.plugin.settings.noteTemplatePath = value;
						await this.plugin.saveSettings();
					});
				new FileSuggest(this.app, text.inputEl);
			});

		/* eslint-disable obsidianmd/ui/sentence-case */
		new Setting(containerEl)
			.setName("MacWhisper")
			.setHeading();
		/* eslint-enable obsidianmd/ui/sentence-case */

		new Setting(containerEl)
			.setName("Database path")
			.setDesc(MACWHISPER_DB_PATH)
			.setDisabled(true);

		new Setting(containerEl)
			.setName("Recording match window (minutes)")
			.setDesc("How close a recording start must be to the scheduled meeting time to be suggested for linking")
			.addText(text => text
				.setPlaceholder("10")
				.setValue(String(this.plugin.settings.recordingWindowMinutes))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.recordingWindowMinutes = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Unlinked lookback (days)")
			.setDesc("How far back to check for unlinked recordings")
			.addText(text => text
				.setPlaceholder("30")
				.setValue(String(this.plugin.settings.unlinkedLookbackDays))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.unlinkedLookbackDays = num;
						await this.plugin.saveSettings();
					}
				}));

		/* eslint-disable obsidianmd/ui/sentence-case */
		new Setting(containerEl)
			.setName("LLM")
			.setHeading();

		new Setting(containerEl)
			.setName("Speaker tagging prompt")
			.setDesc("Vault-relative or absolute path to the Claude Code prompt file for tagging speakers (e.g. Prompts/Speaker Tagging.md)")
			.addText(text => {
				text.setPlaceholder("Prompts/Speaker Tagging.md")
					.setValue(this.plugin.settings.speakerTaggingPromptPath)
					.onChange(async (value) => {
						this.plugin.settings.speakerTaggingPromptPath = value;
						await this.plugin.saveSettings();
					});
				new FileSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("Summarizer prompt")
			.setDesc("Vault-relative or absolute path to the Claude Code prompt file for summarizing transcripts (e.g. Prompts/Meeting Summarizer.md)")
			.addText(text => {
				text.setPlaceholder("Prompts/Meeting Summarizer.md")
					.setValue(this.plugin.settings.summarizerPromptPath)
					.onChange(async (value) => {
						this.plugin.settings.summarizerPromptPath = value;
						await this.plugin.saveSettings();
					});
				new FileSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName("Microphone user")
			.setDesc("Your full name as it appears in meeting notes — passed to the LLM to identify your voice in transcripts")
			.addText(text => text
				.setPlaceholder("Full name")
				.setValue(this.plugin.settings.microphoneUser)
				.onChange(async (value) => {
					this.plugin.settings.microphoneUser = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("CLI command")
			.setDesc("Command used to invoke the LLM (default: claude)")
			.addText(text => text
				.setPlaceholder("claude")
				.setValue(this.plugin.settings.llmCli)
				.onChange(async (value) => {
					this.plugin.settings.llmCli = value.trim() || "claude";
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Additional flags")
			.setDesc("Extra CLI flags appended to the LLM command (optional)")
			.addText(text => text
				.setPlaceholder("")
				.setValue(this.plugin.settings.llmExtraFlags)
				.onChange(async (value) => {
					this.plugin.settings.llmExtraFlags = value;
					await this.plugin.saveSettings();
				}));

		/* eslint-enable obsidianmd/ui/sentence-case */

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("LLM timeout (minutes)")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Kill the LLM process if it runs longer than this (0 = no timeout)")
			.addText(text => text
				.setValue(String(this.plugin.settings.llmTimeoutMinutes))
				.onChange(async (value) => {
					const n = parseInt(value);
					if (!isNaN(n) && n >= 0) {
						this.plugin.settings.llmTimeoutMinutes = n;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName("Max concurrent LLM processes")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Maximum number of LLM processes that can run simultaneously")
			.addText(text => text
				.setValue(String(this.plugin.settings.llmMaxConcurrent))
				.onChange(async (value) => {
					const n = parseInt(value);
					if (!isNaN(n) && n >= 1) {
						this.plugin.settings.llmMaxConcurrent = n;
						await this.plugin.saveSettings();
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
					try {
						Intl.DateTimeFormat(undefined, {timeZone: value});
					} catch {
						return; // Ignore invalid timezone — keep previous value
					}
					this.plugin.settings.timezone = value;
					await this.plugin.saveSettings();
				}));

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
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.refreshIntervalMinutes = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Cache future days")
			.setDesc("Number of upcoming days to pre-fetch for offline access")
			.addText(text => text
				.setPlaceholder("5")
				.setValue(String(this.plugin.settings.cacheFutureDays))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 0) {
						this.plugin.settings.cacheFutureDays = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Cache retention (days)")
			.setDesc("How many days of past calendar data to keep in the local cache")
			.addText(text => text
				.setPlaceholder("30")
				.setValue(String(this.plugin.settings.cacheRetentionDays))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.cacheRetentionDays = num;
						await this.plugin.saveSettings();
					}
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

		let deviceLoginUrlInput: import("obsidian").TextComponent | null = null;

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
					const oldDefault = CLOUD_ENDPOINTS[this.plugin.settings.cloudInstance].deviceLoginUrl;
					this.plugin.settings.cloudInstance = value as CloudInstance;
					const newDefault = CLOUD_ENDPOINTS[this.plugin.settings.cloudInstance].deviceLoginUrl;
					// If the URL field is empty or matches the old cloud's default, clear it
					const current = this.plugin.settings.deviceLoginUrl.trim();
					if (!current || current === oldDefault) {
						this.plugin.settings.deviceLoginUrl = "";
						deviceLoginUrlInput?.setValue("");
					}
					deviceLoginUrlInput?.setPlaceholder(newDefault);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Device login URL")
			.setDesc("Override the device code login URL. Leave empty to use the cloud default.")
			.addText(text => {
				deviceLoginUrlInput = text;
				const defaultUrl = CLOUD_ENDPOINTS[this.plugin.settings.cloudInstance].deviceLoginUrl;
				text.setPlaceholder(defaultUrl)
					.setValue(this.plugin.settings.deviceLoginUrl)
					.onChange(async (value) => {
						this.plugin.settings.deviceLoginUrl = value.trim();
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

	private renderImportantOrganizers(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName("Important organizers")
			.setDesc("Meetings organized by these people show an alert icon in the gutter");

		// Put everything inside the setting's controlEl so it stays in the shaded area
		const controlEl = setting.controlEl;
		controlEl.addClass("whisper-cal-important-organizers-control");

		const listEl = controlEl.createDiv({cls: "whisper-cal-email-list"});

		const renderList = () => {
			listEl.empty();
			for (const email of this.plugin.settings.importantOrganizerEmails) {
				const row = listEl.createDiv({cls: "whisper-cal-email-row"});
				row.createSpan({cls: "whisper-cal-email-text", text: email});
				const removeBtn = row.createEl("button", {
					cls: "whisper-cal-email-remove",
					attr: {"aria-label": "Remove"},
				});
				removeBtn.setText("\u00D7");
				removeBtn.addEventListener("click", async () => {
					this.plugin.settings.importantOrganizerEmails =
						this.plugin.settings.importantOrganizerEmails.filter(e => e !== email);
					await this.plugin.saveSettings();
					renderList();
				});
			}
		};

		renderList();

		const addRow = controlEl.createDiv({cls: "whisper-cal-email-add-row"});
		const inputWrapper = addRow.createDiv({cls: "whisper-cal-email-input-wrapper"});
		const input = inputWrapper.createEl("input", {
			type: "text",
			cls: "whisper-cal-email-input",
			attr: {placeholder: "Search people or type an email"},
		});
		const suggestionsEl = inputWrapper.createDiv({cls: "whisper-cal-email-suggestions"});
		const addBtn = addRow.createEl("button", {
			cls: "whisper-cal-btn whisper-cal-btn-secondary",
			text: "Add",
		});
		const errorEl = controlEl.createDiv({cls: "whisper-cal-email-error"});

		// Graph API people search with debounce
		let searchTimer: number | null = null;
		let selectedIndex = -1;

		interface PeopleSuggestion {
			name: string;
			email: string;
		}

		let suggestions: PeopleSuggestion[] = [];

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
				item.createDiv({cls: "whisper-cal-email-suggestion-name", text: s.name});
				item.createDiv({cls: "whisper-cal-email-suggestion-email", text: s.email});
				item.addEventListener("mousedown", (e) => {
					e.preventDefault();
					pickSuggestion(s);
				});
			}
		};

		const pickSuggestion = (s: PeopleSuggestion) => {
			input.value = s.email;
			suggestions = [];
			selectedIndex = -1;
			renderSuggestions();
			void addEmail();
		};

		const searchPeople = async (query: string) => {
			if (query.length < 2) {
				suggestions = [];
				selectedIndex = -1;
				renderSuggestions();
				return;
			}
			try {
				if (!this.plugin.auth.isSignedIn()) return;
				const token = await this.plugin.auth.getAccessToken();
				const graphBase = this.plugin.auth.getGraphBaseUrl();
				const encoded = encodeURIComponent(`"${query}"`);
				const response = await requestUrl({
					url: `${graphBase}/v1.0/me/people?$search=${encoded}&$top=5&$select=displayName,scoredEmailAddresses`,
					method: "GET",
					headers: {Authorization: `Bearer ${token}`},
				});
				const data = response.json as {
					value?: Array<{
						displayName?: string;
						scoredEmailAddresses?: Array<{address?: string}>;
					}>;
				};
				suggestions = (data.value ?? [])
					.filter(p => p.scoredEmailAddresses?.[0]?.address)
					.map(p => ({
						name: p.displayName ?? "",
						email: (p.scoredEmailAddresses![0]!.address!).toLowerCase(),
					}));
				selectedIndex = -1;
				renderSuggestions();
			} catch {
				// Silently ignore search errors
			}
		};

		input.addEventListener("input", () => {
			if (searchTimer !== null) window.clearTimeout(searchTimer);
			const query = input.value.trim();
			errorEl.setText("");
			searchTimer = window.setTimeout(() => void searchPeople(query), 300);
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
					selectedIndex = Math.max(selectedIndex - 1, 0);
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
			if (e.key === "Enter") {
				e.preventDefault();
				void addEmail();
			}
		});

		input.addEventListener("blur", () => {
			// Delay to allow mousedown on suggestion to fire
			window.setTimeout(() => {
				suggestions = [];
				selectedIndex = -1;
				renderSuggestions();
			}, 200);
		});

		const addEmail = async () => {
			const value = input.value.trim().toLowerCase();
			errorEl.setText("");

			if (!value) return;

			const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
			if (!emailRegex.test(value)) {
				errorEl.setText("Invalid email address");
				return;
			}

			if (this.plugin.settings.importantOrganizerEmails.includes(value)) {
				errorEl.setText("Already in list");
				return;
			}

			this.plugin.settings.importantOrganizerEmails.push(value);
			await this.plugin.saveSettings();
			input.value = "";
			suggestions = [];
			selectedIndex = -1;
			renderSuggestions();
			renderList();
		};

		addBtn.addEventListener("click", () => void addEmail());
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
