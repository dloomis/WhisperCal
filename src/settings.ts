import {App, Modal, Platform, PluginSettingTab, Setting, TextComponent, requestUrl} from "obsidian";
import type WhisperCalPlugin from "./main";
import type {AuthState, CloudInstance} from "./services/AuthTypes";
import {CLOUD_INSTANCE_OPTIONS} from "./services/AuthTypes";
import type {CalendarProviderType} from "./types";
import {MACWHISPER_DB_PATH} from "./constants";
import {FileSuggest} from "./ui/FileSuggest";
import {FolderSuggest} from "./ui/FolderSuggest";
import {FolderSelectModal} from "./ui/FolderSelectModal";
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
	seriesNotesFolderPath: string;
	unscheduledSubject: string;
	recordingWindowMinutes: number;
	unlinkedLookbackDays: number;
	speakerTaggingPromptPath: string;
	summarizerPromptPath: string;
	researchPromptPath: string;
	microphoneUser: string;
	rosterMaxEnriched: number;
	speakerTagClipSeconds: number;
	llmEnabled: boolean;
	anthropicApiKey: string;
	llmCli: string;
	llmExtraFlags: string;
	speakerTagModel: string;
	summarizerModel: string;
	researchModel: string;
	speakerTagFlags: string;
	summarizerFlags: string;
	researchFlags: string;
	llmTimeoutMinutes: number;
	llmMaxConcurrent: number;
	llmDebugMode: boolean;
	llmDebugLogging: boolean;
	/**
	 * "Automatic mode" switch. Despite the name (kept so existing installs keep
	 * their value), this now gates the whole automatic workflow: background
	 * auto-tagging of newly linked transcripts (AutoSpeakerTagger) AND
	 * auto-summarize after the user applies tags — not just summarization.
	 */
	autoSummarizeAfterTagging: boolean;
	/** Startup catch-up scan window for auto-tagging, in hours. 0 disables the scan. */
	autoTagLookbackHours: number;
	showAllDayEvents: boolean;
	importantOrganizers: ImportantOrganizer[];
	cacheFutureDays: number;
	cacheRetentionDays: number;
	timeFormat: "auto" | "12h" | "24h";
	replacementFilePath: string;
	autoCreatePeopleNotes: boolean;
	peopleTemplatePath: string;
	recordingSource: "macwhisper" | "api";
	recordingApiBaseUrl: string;
	skipWordReplacementConfirm: boolean;
	voiceprintFolderPath: string;
	/** Min cosine similarity (0–1) to accept an acoustic voiceprint match. Higher = stricter. */
	voiceprintMatchFloor: number;
	/**
	 * When true, skip the speaker-tag modal and silently apply tags whenever every speaker
	 * is a confident voiceprint match at or above voiceprintAutoTagFloor. To guard against
	 * voiceprint drift, these silent auto-tags never enroll or update any voiceprint library —
	 * libraries only change when you confirm in the modal.
	 */
	voiceprintAutoTagSkipModal: boolean;
	/**
	 * High-confidence cosine floor (0–1) every speaker must clear for a silent auto-tag.
	 * Only consulted when voiceprintAutoTagSkipModal is on. Kept high so the bar to skip the
	 * modal stays strict.
	 */
	voiceprintAutoTagFloor: number;
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
	seriesNotesFolderPath: "",
	unscheduledSubject: "Unscheduled Meeting",
	recordingWindowMinutes: 15,
	unlinkedLookbackDays: 30,
	speakerTaggingPromptPath: "Prompts/Transcript Post-Processing Prompt.md",
	summarizerPromptPath: "Prompts/Meeting Transcript Summarizer Prompt.md",
	researchPromptPath: "Prompts/Meeting Research Prompt.md",
	microphoneUser: "",
	rosterMaxEnriched: 20,
	speakerTagClipSeconds: 5,
	llmEnabled: false,
	anthropicApiKey: "",
	llmCli: "claude",
	llmExtraFlags: "--dangerously-skip-permissions",
	speakerTagModel: "",
	summarizerModel: "",
	researchModel: "",
	speakerTagFlags: "",
	summarizerFlags: "",
	researchFlags: "",
	llmTimeoutMinutes: 10,
	llmMaxConcurrent: 2,
	llmDebugMode: false,
	llmDebugLogging: false,
	autoSummarizeAfterTagging: false,
	autoTagLookbackHours: 48,
	showAllDayEvents: false,
	importantOrganizers: [],
	cacheFutureDays: 5,
	cacheRetentionDays: 30,
	timeFormat: "auto",
	replacementFilePath: "Prompts/Word Replacements.md",
	autoCreatePeopleNotes: false,
	peopleTemplatePath: "",
	recordingSource: "macwhisper",
	recordingApiBaseUrl: "",
	skipWordReplacementConfirm: false,
	voiceprintFolderPath: "Caches/Voiceprints",
	voiceprintMatchFloor: 0.50, // mirrors DEFAULT_MATCH_FLOOR in VoiceprintMatcher.ts
	voiceprintAutoTagSkipModal: false,
	voiceprintAutoTagFloor: 0.80,
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

	/**
	 * Add a lightweight sub-section heading. Visually lighter than `setHeading()`
	 * at the top level (see `.whisper-cal-subheading` in styles.css) so nested
	 * groups read as children of the section above them, not as peer sections.
	 */
	private addSubHeading(container: HTMLElement, name: string): void {
		new Setting(container)
			.setName(name)
			.setHeading()
			.settingEl.addClass("whisper-cal-subheading");
	}

	/**
	 * Create a text-input setting bound to a getter/setter. Uses debouncedSave.
	 * For non-trivial onChange logic (validation, side effects, dependent UI),
	 * keep using `new Setting(...)` directly.
	 */
	private addTextSetting(opts: {
		container: HTMLElement;
		name: string;
		desc: string;
		placeholder?: string;
		get: () => string;
		set: (v: string) => void;
		/** When true, store `value.trim()` instead of `value`. */
		trim?: boolean;
		/** Mount a FileSuggest or FolderSuggest on the input element. */
		suggest?: "file" | "folder";
		/** Add a "Browse" button that opens a vault-folder picker. */
		browse?: boolean;
	}): Setting {
		const s = new Setting(opts.container).setName(opts.name).setDesc(opts.desc);
		let textComp: TextComponent | null = null;
		s.addText(text => {
			textComp = text;
			if (opts.placeholder) text.setPlaceholder(opts.placeholder);
			text.setValue(opts.get())
				.onChange((value) => {
					opts.set(opts.trim ? value.trim() : value);
					this.debouncedSave();
				});
			if (opts.suggest === "folder") new FolderSuggest(this.app, text.inputEl);
			else if (opts.suggest === "file") new FileSuggest(this.app, text.inputEl);
		});
		if (opts.browse) {
			s.addButton(btn => btn
				.setButtonText("Browse")
				.setTooltip("Choose a vault folder")
				.onClick(async () => {
					const folder = await new FolderSelectModal(this.app).pick();
					if (folder !== null) {
						const v = opts.trim ? folder.trim() : folder;
						opts.set(v);
						textComp?.setValue(v);
						this.debouncedSave();
					}
				}));
		}
		return s;
	}

	/**
	 * Create a toggle setting bound to a boolean getter/setter. Saves immediately
	 * via `plugin.saveSettings()`. For toggles with custom side effects (consent
	 * flows, dependent UI rerenders), keep `new Setting(...)` direct.
	 */
	private addToggleSetting(opts: {
		container: HTMLElement;
		name: string;
		desc: string;
		get: () => boolean;
		set: (v: boolean) => void;
	}): Setting {
		return new Setting(opts.container)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addToggle(toggle => toggle
				.setValue(opts.get())
				.onChange(async (value) => {
					opts.set(value);
					await this.plugin.saveSettings();
				}));
	}

	/**
	 * Create a numeric text-input setting. Parses input as int and only writes
	 * when the value satisfies `min <= value` (default min=1). Uses debouncedSave.
	 */
	private addNumberSetting(opts: {
		container: HTMLElement;
		name: string;
		desc: string;
		placeholder?: string;
		min?: number;
		get: () => number;
		set: (v: number) => void;
	}): Setting {
		const min = opts.min ?? 1;
		return new Setting(opts.container)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addText(text => text
				.setPlaceholder(opts.placeholder ?? String(min))
				.setValue(String(opts.get()))
				.onChange((value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= min) {
						opts.set(num);
						this.debouncedSave();
					}
				}));
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

		this.addTextSetting({
			container: containerEl,
			name: "People folder",
			desc: "Vault folder containing people notes. Matched attendees render as [[wiki links]] in meeting notes.",
			placeholder: "People",
			get: () => this.plugin.settings.peopleFolderPath,
			set: v => { this.plugin.settings.peopleFolderPath = v; },
			suggest: "folder",
			browse: true,
		});

		this.addToggleSetting({
			container: containerEl,
			name: "Auto-create people notes",
			desc: "Automatically create people notes for meeting organizers and newly-tagged speakers without one. Organizers need a people template; tagged speakers fall back to a minimal note.",
			get: () => this.plugin.settings.autoCreatePeopleNotes,
			set: v => { this.plugin.settings.autoCreatePeopleNotes = v; },
		});

		this.addTextSetting({
			container: containerEl,
			name: "People template",
			desc: "Vault file used as a template for auto-created people notes. Available: {{full_name}}, {{nickname}}, {{email}}, {{organization}}",
			placeholder: "Templates/Person.md",
			get: () => this.plugin.settings.peopleTemplatePath,
			set: v => { this.plugin.settings.peopleTemplatePath = v; },
			suggest: "file",
		});

		this.addTextSetting({
			container: containerEl,
			name: "Notes folder",
			desc: "Vault folder where meeting notes are created",
			placeholder: "Meetings",
			get: () => this.plugin.settings.noteFolderPath,
			set: v => { this.plugin.settings.noteFolderPath = v; },
			suggest: "folder",
			browse: true,
		});

		this.addTextSetting({
			container: containerEl,
			name: "Transcripts folder",
			desc: "Vault folder where transcript files are created when linking recordings",
			placeholder: "Transcripts",
			get: () => this.plugin.settings.transcriptFolderPath,
			set: v => { this.plugin.settings.transcriptFolderPath = v; },
			suggest: "folder",
			browse: true,
		});

		this.addTextSetting({
			container: containerEl,
			name: "Note filename template",
			desc: "Template for meeting note filenames. Available: {{date}} (YYYY-MM-DD), {{time}} (HHmm, 24-hour), {{subject}}. Add {{time}} to keep two same-subject meetings on the same day in separate notes.",
			placeholder: "{{date}} {{time}} - {{subject}}",
			get: () => this.plugin.settings.noteFilenameTemplate,
			set: v => { this.plugin.settings.noteFilenameTemplate = v; },
		});

		this.addTextSetting({
			container: containerEl,
			name: "Unscheduled note subject",
			desc: "Subject used for ad-hoc meeting notes not tied to a calendar event",
			placeholder: "Unscheduled Meeting",
			get: () => this.plugin.settings.unscheduledSubject,
			set: v => { this.plugin.settings.unscheduledSubject = v; },
		});

		this.addTextSetting({
			container: containerEl,
			name: "Note template",
			desc: "Vault file used as a template for meeting note content. Copy the sample template from the plugin's samples/ folder into your vault and set the path here.",
			placeholder: "Templates/WhisperCal Meeting.md",
			get: () => this.plugin.settings.noteTemplatePath,
			set: v => { this.plugin.settings.noteTemplatePath = v; },
			suggest: "file",
		});

		new Setting(containerEl)
			.setName("Word replacement file")
			.setDesc("Vault path to a word replacement file applied to transcripts after speaker tagging (one per line: search,replace)")
			.addText(text => {
				text.setPlaceholder("Prompts/Word Replacements.md")
					.setValue(this.plugin.settings.replacementFilePath)
					.onChange((value) => {
						this.plugin.settings.replacementFilePath = value;
						this.debouncedSave();
					});
				new FileSuggest(this.app, text.inputEl);
			})
			.addButton(button => button
				.setButtonText("Open")
				.onClick(async () => {
					const filePath = this.plugin.settings.replacementFilePath;
					if (!filePath) {
						return;
					}
					if (!this.app.vault.getAbstractFileByPath(filePath)) {
						await this.app.vault.create(filePath, "# Word replacements (one per line: search,replace)\n");
					}
					void this.app.workspace.openLinkText(filePath, "", false);
				}));

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

		containerEl.createEl("div", {
			cls: "whisper-cal-settings-warning",
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "OAuth" is a product term
			text: "OAuth tokens are stored unencrypted in this vault's plugin data folder. Avoid syncing the data file to untrusted services; revoke access from the provider's account portal if the file is exposed.",
		});

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

		this.addToggleSetting({
			container: containerEl,
			name: "Show all-day events",
			desc: "Display all-day events in the calendar view",
			get: () => this.plugin.settings.showAllDayEvents,
			set: v => { this.plugin.settings.showAllDayEvents = v; },
		});

		this.renderImportantOrganizers(containerEl);

		this.addNumberSetting({
			container: containerEl,
			name: "Refresh interval (minutes)",
			desc: "How often to refresh the calendar view",
			placeholder: "5",
			get: () => this.plugin.settings.refreshIntervalMinutes,
			set: v => { this.plugin.settings.refreshIntervalMinutes = v; },
		});

		this.addNumberSetting({
			container: containerEl,
			name: "Cache future days",
			desc: "Number of upcoming days to pre-fetch for offline access",
			placeholder: "5",
			min: 0,
			get: () => this.plugin.settings.cacheFutureDays,
			set: v => { this.plugin.settings.cacheFutureDays = v; },
		});

		this.addNumberSetting({
			container: containerEl,
			name: "Cache retention (days)",
			desc: "How many days of past calendar data to keep in the local cache",
			placeholder: "30",
			get: () => this.plugin.settings.cacheRetentionDays,
			set: v => { this.plugin.settings.cacheRetentionDays = v; },
		});

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
			.addDropdown(dropdown => {
				if (Platform.isMacOS) {
					dropdown.addOption("macwhisper", "MacWhisper");
				}
				dropdown
					.addOption("api", "Recording API")
					.setValue(this.plugin.settings.recordingSource)
					.onChange((value: string) => {
						this.plugin.settings.recordingSource = value as "macwhisper" | "api";
						this.debouncedSave();
						updateRecordingVisibility();
					});
			});
		// Move Source dropdown above the sub-setting containers
		containerEl.insertBefore(sourceSetting.settingEl, macwhisperSettings);
		/* eslint-enable obsidianmd/ui/sentence-case */

		// MacWhisper sub-settings
		new Setting(macwhisperSettings)
			.setName("Database path")
			.setDesc(MACWHISPER_DB_PATH)
			.setDisabled(true);

		this.addNumberSetting({
			container: macwhisperSettings,
			name: "Recording match window (minutes)",
			desc: "How close a recording start must be to the scheduled meeting time to be suggested for linking",
			placeholder: "10",
			get: () => this.plugin.settings.recordingWindowMinutes,
			set: v => { this.plugin.settings.recordingWindowMinutes = v; },
		});

		this.addNumberSetting({
			container: macwhisperSettings,
			name: "Unlinked lookback (days)",
			desc: "How far back to check for unlinked recordings",
			placeholder: "30",
			get: () => this.plugin.settings.unlinkedLookbackDays,
			set: v => { this.plugin.settings.unlinkedLookbackDays = v; },
		});

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

		// Automatic mode — repurposes the autoSummarizeAfterTagging key (same
		// key, existing installs keep their value) as the switch for the whole
		// automatic workflow: background auto-tag + auto-summarize after apply.
		const autoTagSubSettings = containerEl.createDiv();
		const autoModeSetting = new Setting(containerEl)
			.setName("Automatic mode")
			.setDesc(
				"Run the LLM workflow automatically: when a transcript is linked to a meeting note, " +
				"tag speakers in the background and cache the candidates (the Transcript pill's badge turns green " +
				"when they're ready to review — tags are never applied without your confirmation), then " +
				"start summarization after you apply them. Single-mic recordings are skipped. " +
				"Off = run each stage manually from the pill badges.",
			)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSummarizeAfterTagging)
				.onChange(async (value) => {
					this.plugin.settings.autoSummarizeAfterTagging = value;
					await this.plugin.saveSettings();
					autoTagSubSettings.toggle(value);
				}));
		// Move the toggle above its sub-setting container
		containerEl.insertBefore(autoModeSetting.settingEl, autoTagSubSettings);

		this.addNumberSetting({
			container: autoTagSubSettings,
			name: "Auto-tag catch-up window (hours)",
			desc: "On startup, also auto-tag eligible transcripts created within this many hours. 0 disables the startup scan.",
			placeholder: "48",
			min: 0,
			get: () => this.plugin.settings.autoTagLookbackHours,
			set: v => { this.plugin.settings.autoTagLookbackHours = v; },
		});
		autoTagSubSettings.toggle(this.plugin.settings.autoSummarizeAfterTagging);

		// ── CLI & runtime: shared invocation settings that apply to every prompt ──
		this.addSubHeading(containerEl, "CLI & runtime");

		// CLI command has a "fall back to claude on empty" rule — keep direct.
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

		this.addTextSetting({
			container: containerEl,
			name: "Additional flags (all prompts)",
			desc: "Extra CLI flags appended to every LLM command. " +
				"⚠️ The default --dangerously-skip-permissions is required for " +
				"non-interactive LLM usage — removing it will break speaker tagging " +
				"and summarization. Use the per-prompt flags below for task-specific options.",
			placeholder: "--dangerously-skip-permissions",
			get: () => this.plugin.settings.llmExtraFlags,
			set: v => { this.plugin.settings.llmExtraFlags = v; },
		});

		new Setting(containerEl)
			.setName("Anthropic API key")
			.setDesc("Used to populate model dropdowns. Not sent to the CLI — the CLI uses its own auth.")
			.addText(text => {
				text.inputEl.type = "password";
				text.setPlaceholder("sk-ant-...")
					.setValue(this.plugin.settings.anthropicApiKey)
					.onChange((value) => {
						this.plugin.settings.anthropicApiKey = value.trim();
						this.debouncedSave();
						void refreshModels();
					});
			});

		this.addNumberSetting({
			container: containerEl,
			name: "LLM timeout (minutes)",
			desc: "Kill the LLM process if it runs longer than this (0 = no timeout). Transcript post-processing reads and rewrites the whole transcript, so give it headroom.",
			min: 0,
			get: () => this.plugin.settings.llmTimeoutMinutes,
			set: v => { this.plugin.settings.llmTimeoutMinutes = v; },
		});

		this.addNumberSetting({
			container: containerEl,
			name: "Max concurrent LLM processes",
			desc: "Maximum number of LLM processes that can run simultaneously",
			get: () => this.plugin.settings.llmMaxConcurrent,
			set: v => { this.plugin.settings.llmMaxConcurrent = v; },
		});

		if (Platform.isMacOS) {
			this.addToggleSetting({
				container: containerEl,
				name: "Debug mode",
				desc: "Open LLM commands in a Terminal window instead of running in the background",
				get: () => this.plugin.settings.llmDebugMode,
				set: v => { this.plugin.settings.llmDebugMode = v; },
			});
		}

		this.addToggleSetting({
			container: containerEl,
			name: "Debug logging",
			desc: "Log detailed diagnostics — LLM commands and stdout, speaker tagging, and voiceprint enrollment — to the developer console (Cmd+Opt+I). Off by default to avoid leaking meeting content.",
			get: () => this.plugin.settings.llmDebugLogging,
			set: v => { this.plugin.settings.llmDebugLogging = v; },
		});

		// Per-prompt settings: each prompt has its own sub-section with a file
		// path, model, and additional flags appended after the global flags.
		// Each select is paired with its model key so refreshModels() doesn't
		// depend on the order the prompt sub-sections are rendered.
		const modelSelects: {sel: HTMLSelectElement; key: "speakerTagModel" | "summarizerModel" | "researchModel"}[] = [];

		const addPromptSetting = (
			name: string,
			promptDesc: string,
			placeholder: string,
			pathKey: "speakerTaggingPromptPath" | "summarizerPromptPath" | "researchPromptPath",
			modelKey: "speakerTagModel" | "summarizerModel" | "researchModel",
			flagsKey: "speakerTagFlags" | "summarizerFlags" | "researchFlags",
		) => {
			this.addSubHeading(containerEl, name);

			new Setting(containerEl)
				.setName("Prompt")
				.setDesc(promptDesc)
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
				.setName("Model")
				.setDesc(`Claude model for ${name.toLowerCase()}. Set the API key above to load available models.`)
				.addDropdown(dropdown => {
					modelSelects.push({sel: dropdown.selectEl, key: modelKey});
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

			this.addTextSetting({
				container: containerEl,
				name: "Additional flags",
				desc: `Extra CLI flags for ${name.toLowerCase()} only, appended after the global flags above (e.g. --effort medium). Leave empty to use only the global flags.`,
				placeholder: "--effort medium",
				get: () => this.plugin.settings[flagsKey],
				set: v => { this.plugin.settings[flagsKey] = v; },
			});
		};

		addPromptSetting(
			"Summarizer",
			"Vault-relative or absolute path to the Claude Code prompt file for summarizing transcripts (e.g. Prompts/Meeting Summarizer.md)",
			"Prompts/Meeting Summarizer.md",
			"summarizerPromptPath",
			"summarizerModel",
			"summarizerFlags",
		);

		addPromptSetting(
			"Research",
			"Vault-relative or absolute path to the Claude Code prompt file for meeting research (e.g. Prompts/Meeting Research.md)",
			"Prompts/Meeting Research.md",
			"researchPromptPath",
			"researchModel",
			"researchFlags",
		);

		this.addTextSetting({
			container: containerEl,
			name: "Meeting series notes folder",
			desc: "Vault folder of per-series notes for recurring meetings. Each note holds bespoke research instructions (under a '## Research instructions' heading) that pre-fill the Research modal for that series. Leave empty to disable.",
			placeholder: "Meeting Series",
			get: () => this.plugin.settings.seriesNotesFolderPath,
			set: v => { this.plugin.settings.seriesNotesFolderPath = v; },
			suggest: "folder",
			browse: true,
		});

		// ── Speaker tagging ──────────────────────────────────────────────
		// Acoustic voiceprint matching (LLM-free) plus the LLM fallback prompt
		// and the modal/roster knobs that shape the Speakers pipeline stage.
		new Setting(containerEl)
			.setName("Speaker tagging")
			.setHeading();

		this.addTextSetting({
			container: containerEl,
			name: "Speaker voiceprints folder",
			desc: "Vault folder where per-speaker voice embeddings are stored for acoustic speaker matching. Populated when you apply speaker tags to a transcript that has a voiceprint sidecar (.voiceprints.json) next to it.",
			placeholder: "Caches/Voiceprints",
			get: () => this.plugin.settings.voiceprintFolderPath,
			set: v => { this.plugin.settings.voiceprintFolderPath = v; },
			suggest: "folder",
			browse: true,
		});

		// Float in [0, 1] — addNumberSetting only handles integers, so parse inline.
		new Setting(containerEl)
			.setName("Voiceprint match floor")
			.setDesc(
				"Minimum cosine similarity (0–1) required to accept an acoustic speaker match. " +
				"Higher is stricter: fewer false matches, but more speakers left for you to confirm by ear. " +
				"Default 0.50. Solo-library matches always use at least 0.55.",
			)
			.addText(text => text
				.setPlaceholder("0.50")
				.setValue(String(this.plugin.settings.voiceprintMatchFloor))
				.onChange((value) => {
					const num = parseFloat(value);
					if (!isNaN(num) && num >= 0 && num <= 1) {
						this.plugin.settings.voiceprintMatchFloor = num;
						this.debouncedSave();
					}
				}));

		// Auto-tag (skip the modal) — silently apply tags when every speaker is a confident
		// voiceprint match. The confidence-floor sub-setting is only shown while the feature is
		// on. Drift guard: silent auto-tags never enroll or update a library; that only happens
		// when you confirm in the modal.
		const autoTagSkipSub = containerEl.createDiv();
		const autoTagSkipSetting = new Setting(containerEl)
			.setName("Auto-tag when all speakers match")
			.setDesc(
				"Skip the speaker-tagging modal and apply tags automatically when every speaker is a " +
				"confident voiceprint match at or above the floor below. Voiceprint libraries are never " +
				"updated on a silent auto-tag — only confirming in the modal enrolls or corrects them.",
			)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.voiceprintAutoTagSkipModal)
				.onChange(async (value) => {
					this.plugin.settings.voiceprintAutoTagSkipModal = value;
					await this.plugin.saveSettings();
					autoTagSkipSub.toggle(value);
				}));
		// Move the toggle above its sub-setting container.
		containerEl.insertBefore(autoTagSkipSetting.settingEl, autoTagSkipSub);

		// Float in [0, 1] — addNumberSetting only handles integers, so parse inline.
		new Setting(autoTagSkipSub)
			.setName("Auto-tag confidence floor")
			.setDesc(
				"Minimum cosine similarity (0–1) every speaker must reach for the modal to be skipped. " +
				"Keep it high so unattended tagging stays strict. Default 0.80.",
			)
			.addText(text => text
				.setPlaceholder("0.80")
				.setValue(String(this.plugin.settings.voiceprintAutoTagFloor))
				.onChange((value) => {
					const num = parseFloat(value);
					if (!isNaN(num) && num >= 0 && num <= 1) {
						this.plugin.settings.voiceprintAutoTagFloor = num;
						this.debouncedSave();
					}
				}));
		autoTagSkipSub.toggle(this.plugin.settings.voiceprintAutoTagSkipModal);

		addPromptSetting(
			"Transcript post-processing",
			"Path to the prompt that fixes transcription and diarization errors in the transcript and proposes names for speakers voiceprints didn't match (e.g. Prompts/Transcript Post-Processing Prompt.md). Leave empty to skip the LLM step — known people are still matched by voiceprint and unknowns confirmed by ear in the modal.",
			"Prompts/Transcript Post-Processing Prompt.md",
			"speakerTaggingPromptPath",
			"speakerTagModel",
			"speakerTagFlags",
		);

		this.addTextSetting({
			container: containerEl,
			name: "Microphone user",
			desc: "Your full name as it appears in meeting notes — passed to the LLM to identify your voice in transcripts",
			placeholder: "Full name",
			get: () => this.plugin.settings.microphoneUser,
			set: v => { this.plugin.settings.microphoneUser = v; },
		});

		this.addNumberSetting({
			container: containerEl,
			name: "Roster enrichment cap",
			desc: "Maximum number of meeting invitees to enrich with People note context for speaker tagging. Larger meetings pass all names but only enrich up to this many.",
			get: () => this.plugin.settings.rosterMaxEnriched,
			set: v => { this.plugin.settings.rosterMaxEnriched = v; },
		});

		this.addNumberSetting({
			container: containerEl,
			name: "Speaker clip length (seconds)",
			desc: "When you click a timestamp in the speaker tagging modal, how many seconds of audio to play before stopping. 0 falls back to 5.",
			placeholder: "5",
			min: 0,
			get: () => this.plugin.settings.speakerTagClipSeconds,
			set: v => { this.plugin.settings.speakerTagClipSeconds = v; },
		});

		// Populate all model dropdowns from the API
		const refreshModels = async () => {
			const models = await this.fetchAnthropicModels();
			for (const {sel, key} of modelSelects) {
				const current = this.plugin.settings[key];
				sel.replaceChildren();
				sel.add(new Option("Default", ""));
				for (const m of models) {
					sel.add(new Option(m.display_name, m.id));
				}
				sel.value = current;
			}
		};
		void refreshModels();

		/* eslint-enable obsidianmd/ui/sentence-case */

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
			const apiKey = this.plugin.settings.anthropicApiKey || globalThis.process?.env?.["ANTHROPIC_API_KEY"];
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

		this.addTextSetting({
			container: containerEl,
			name: "Tenant ID",
			desc: "Directory (tenant) ID from Azure AD. Leave empty to auto-detect from your account.",
			placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
			get: () => this.plugin.settings.tenantId,
			set: v => { this.plugin.settings.tenantId = v; },
		});

		this.addTextSetting({
			container: containerEl,
			name: "Client ID",
			desc: "Application (client) ID from your Azure AD app registration",
			placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
			get: () => this.plugin.settings.clientId,
			set: v => { this.plugin.settings.clientId = v; },
		});

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
		this.addTextSetting({
			container: containerEl,
			name: "Client ID",
			desc: "OAuth client ID from your Google Cloud Console desktop app credentials",
			placeholder: "xxxxxxxxxxxx.apps.googleusercontent.com",
			get: () => this.plugin.settings.googleClientId,
			set: v => { this.plugin.settings.googleClientId = v; },
		});

		// Client secret needs `inputEl.type = "password"` — keep direct.
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
