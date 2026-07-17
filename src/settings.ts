import {App, Modal, Notice, Platform, PluginSettingTab, Setting, TextComponent, normalizePath, requestUrl} from "obsidian";
import type WhisperCalPlugin from "./main";
import type {CalendarProviderType} from "./types";
import {getWhisperCoreApi} from "./services/CoreBridge";
import {MACWHISPER_DB_PATH} from "./constants";
import {addActivateOnKey} from "./utils/a11y";
import {recordingStatus, resolveRecordingApiBaseUrl} from "./services/RecordingApi";
import type {PersistedApiRecording} from "./services/ApiRecording";
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
	// Provider auth config (tenant/clientId/cloud, Google id/secret) moved to
	// WhisperCore in the C3 cutover — no longer stored or edited here.
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
	// LLM CLI command, shared flags, and the Anthropic API key moved to
	// WhisperCore in the C4 cutover — read via getLlmConfig(), not stored here.
	speakerTagModel: string;
	summarizerModel: string;
	researchModel: string;
	speakerTagFlags: string;
	summarizerFlags: string;
	researchFlags: string;
	// LLM runtime plumbing (timeout, concurrency cap, debug mode, debug logging)
	// moved to WhisperCore — read via getLlmConfig(), no longer stored here.
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
	/**
	 * Tie recording to the meeting's lifecycle: clicking a meeting's join link on
	 * its calendar card starts recording automatically, and stopping that
	 * recording from WhisperCal closes the meeting app (Teams, Zoom) to leave the
	 * call. Recording API source only. Migrated from the old `autoRecordOnLaunch`.
	 */
	automateMeetingRecording: boolean;
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
	/**
	 * Max share of transcript lines (0–1) below which an unmatched speaker is treated as
	 * negligible (crosstalk, stray utterances) and no longer blocks a silent auto-tag — it is
	 * left untagged, mirroring what a reviewer would do in the modal. Deliberately independent
	 * of the LLM output so it works regardless of what a user-defined prompt returns.
	 * 0 disables the exemption (every speaker must match, the pre-0.7.5 behavior).
	 * Only consulted when voiceprintAutoTagSkipModal is on.
	 */
	voiceprintAutoTagMinorMaxShare: number;
	/** Set once the one-time WhisperCore credential/token hand-off has run
	 *  (DESIGN §8.3). Internal migration flag, not user-facing. */
	coreMigrationDone: boolean;
	/**
	 * In-flight API recording bookkeeping, keyed by session guid
	 * (SESSION_GUID_DESIGN.md §7). Not a user setting — persisted here because
	 * data.json is the plugin's only store — so an Obsidian restart mid-recording
	 * can reconnect instead of orphaning the session. Never surfaced in the
	 * settings UI.
	 */
	activeApiRecordings: PersistedApiRecording[];
}

export const DEFAULT_SETTINGS: WhisperCalSettings = {
	calendarProvider: "microsoft",
	timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/New_York",
	refreshIntervalMinutes: 5,
	noteFolderPath: "Meetings",
	noteFilenameTemplate: "{{date}} - {{subject}}",
	noteTemplatePath: "",
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
	speakerTagModel: "",
	summarizerModel: "",
	researchModel: "",
	speakerTagFlags: "",
	summarizerFlags: "",
	researchFlags: "",
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
	automateMeetingRecording: false,
	skipWordReplacementConfirm: false,
	voiceprintFolderPath: "Caches/Voiceprints",
	voiceprintMatchFloor: 0.50, // mirrors DEFAULT_MATCH_FLOOR in VoiceprintMatcher.ts
	voiceprintAutoTagSkipModal: false,
	voiceprintAutoTagFloor: 0.80,
	voiceprintAutoTagMinorMaxShare: 0.05,
	coreMigrationDone: false,
	activeApiRecordings: [],
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
		this.setTitle("Enable LLM features?");
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

type SettingsTabId = "calendar" | "notes" | "recording" | "speakers" | "summary" | "llm";

export class WhisperCalSettingTab extends PluginSettingTab {
	plugin: WhisperCalPlugin;
	private authUnsubscribe: (() => void) | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private searchTimer: number | null = null;
	/** Active settings tab; persists across re-renders for the session. */
	private activeTab: SettingsTabId = "calendar";
	/** Model dropdowns rendered by the active tab, keyed for refreshModels(). */
	private modelSelects: {sel: HTMLSelectElement; key: "speakerTagModel" | "summarizerModel" | "researchModel"}[] = [];

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
		// Path inputs (suggest set) are normalized so a stray trailing slash or "./"
		// doesn't break consumers like `startsWith(folder + "/")` (which a trailing
		// slash silently defeats) or un-normalized path concatenation. Empty stays
		// empty — for folder settings that means "disabled", which normalizePath
		// would otherwise turn into "/".
		const normalize = (v: string): string => {
			if (opts.suggest) return v.trim() ? normalizePath(v) : "";
			return opts.trim ? v.trim() : v;
		};
		let textComp: TextComponent | null = null;
		s.addText(text => {
			textComp = text;
			if (opts.placeholder) text.setPlaceholder(opts.placeholder);
			text.setValue(opts.get())
				.onChange((value) => {
					opts.set(normalize(value));
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
						const v = normalize(folder);
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
		// Strict integer: parseInt would accept "5x". Show invalid input instead of
		// silently ignoring it, and revert to the stored value on blur.
		const valid = (v: string) => /^\d+$/.test(v.trim()) && Number(v.trim()) >= min;
		return new Setting(opts.container)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addText(text => {
				text.setPlaceholder(opts.placeholder ?? String(min)).setValue(String(opts.get()));
				text.onChange((value) => {
					if (valid(value)) {
						text.inputEl.removeClass("whisper-cal-setting-invalid");
						opts.set(Number(value.trim()));
						this.debouncedSave();
					} else {
						text.inputEl.addClass("whisper-cal-setting-invalid");
					}
				});
				text.inputEl.addEventListener("blur", () => {
					if (!valid(text.inputEl.value)) {
						text.setValue(String(opts.get()));
						text.inputEl.removeClass("whisper-cal-setting-invalid");
					}
				});
			});
	}

	/**
	 * Create a float text-input setting bounded to [min, max]. Like
	 * addNumberSetting, shows invalid input and reverts to the stored value on blur
	 * instead of silently ignoring it.
	 */
	private addFloatSetting(opts: {
		container: HTMLElement;
		name: string;
		desc: string;
		placeholder?: string;
		min: number;
		max: number;
		get: () => number;
		set: (v: number) => void;
	}): Setting {
		const valid = (v: string) => {
			const t = v.trim();
			if (!/^\d*\.?\d+$/.test(t)) return false;
			const n = Number(t);
			return n >= opts.min && n <= opts.max;
		};
		return new Setting(opts.container)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addText(text => {
				text.setPlaceholder(opts.placeholder ?? String(opts.min)).setValue(String(opts.get()));
				text.onChange((value) => {
					if (valid(value)) {
						text.inputEl.removeClass("whisper-cal-setting-invalid");
						opts.set(Number(value.trim()));
						this.debouncedSave();
					} else {
						text.inputEl.addClass("whisper-cal-setting-invalid");
					}
				});
				text.inputEl.addEventListener("blur", () => {
					if (!valid(text.inputEl.value)) {
						text.setValue(String(opts.get()));
						text.inputEl.removeClass("whisper-cal-setting-invalid");
					}
				});
			});
	}

	display(): void {
		// Unsubscribe any previous auth listener to prevent stacking on re-render.
		// The connection status block only exists while the Calendar tab is rendered.
		this.authUnsubscribe?.();
		this.authUnsubscribe = null;
		// Model dropdowns re-register with whichever tab renders them.
		this.modelSelects = [];

		const {containerEl} = this;
		containerEl.empty();
		containerEl.addClass("whisper-cal-settings");

		containerEl.createEl("div", {
			cls: "whisper-cal-settings-version",
			text: `v${this.plugin.manifest.version}`,
		});

		// Tab bar — settings grouped by pipeline stage. Obsidian has no native
		// tab API for plugin settings, so this is a plain button row; the active
		// tab persists on the instance for the session.
		const tabs: {id: SettingsTabId; label: string}[] = [
			{id: "calendar", label: "Calendar"},
			{id: "notes", label: "Notes & people"},
			{id: "recording", label: "Recording"},
			{id: "speakers", label: "Speakers"},
			{id: "summary", label: "Summary & research"},
			 
			{id: "llm", label: "LLM engine"},
		];
		const tabBar = containerEl.createDiv({cls: "whisper-cal-settings-tabbar"});
		for (const tab of tabs) {
			const btn = tabBar.createEl("button", {
				cls: "whisper-cal-settings-tab" + (tab.id === this.activeTab ? " whisper-cal-settings-tab-active" : ""),
				text: tab.label,
			});
			btn.addEventListener("click", () => {
				if (this.activeTab === tab.id) return;
				this.activeTab = tab.id;
				this.display();
			});
		}

		const pane = containerEl.createDiv({cls: "whisper-cal-settings-pane"});
		switch (this.activeTab) {
			case "calendar": this.renderCalendarTab(pane); break;
			case "notes": this.renderNotesTab(pane); break;
			case "recording": this.renderRecordingTab(pane); break;
			case "speakers": this.renderSpeakersTab(pane); break;
			case "summary": this.renderSummaryTab(pane); break;
			case "llm": this.renderLlmTab(pane); break;
		}

		// Populate any model dropdowns the active tab registered.
		void this.refreshModels();
	}

	/** Calendar tab — provider + credentials, display options, refresh/cache. */
	private renderCalendarTab(containerEl: HTMLElement): void {
		// Provider section: the "Managed in WhisperCore" banner, then a single
		// subsection with everything WhisperCal uses for calendar provider
		// functionality — the provider choice plus the values it pulls from Core.
		// Provider credentials (tenant/clientId/cloud, Google id/secret) and the
		// OAuth token live in WhisperCore (DESIGN §8.4); sign in/out still delegates
		// through the API so routine auth never leaves WhisperCal.
		this.addSubHeading(containerEl, "Provider");
		this.renderConnectionStatus(containerEl);

		// General calendar settings (apply to both providers).
		this.addSubHeading(containerEl, "General");

		new Setting(containerEl)
			.setName("Timezone")
			.setDesc("IANA timezone for displaying meeting times (e.g. America/New_York, Europe/London)")
			.addText(text => {
				const validTz = (v: string) => {
					try { Intl.DateTimeFormat(undefined, {timeZone: v.trim()}); return true; }
					catch { return false; }
				};
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					.setPlaceholder("America/New_York")
					.setValue(this.plugin.settings.timezone)
					.onChange((value) => {
						if (validTz(value)) {
							text.inputEl.removeClass("whisper-cal-setting-invalid");
							this.plugin.settings.timezone = value.trim();
							this.debouncedSave();
						} else {
							// Show the invalid input instead of silently keeping the old value.
							text.inputEl.addClass("whisper-cal-setting-invalid");
						}
					});
				text.inputEl.addEventListener("blur", () => {
					if (!validTz(text.inputEl.value)) {
						text.setValue(this.plugin.settings.timezone);
						text.inputEl.removeClass("whisper-cal-setting-invalid");
					}
				});
			});

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
	}

	/** Notes & people tab — where notes land and how they're templated. */
	private renderNotesTab(containerEl: HTMLElement): void {
		this.addSubHeading(containerEl, "Meeting notes");

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
			name: "Note filename template",
			desc: "Template for meeting note filenames. Available: {{date}} (YYYY-MM-DD), {{time}} (HHmm, 24-hour), {{subject}}. Add {{time}} to keep two same-subject meetings on the same day in separate notes.",
			placeholder: "{{date}} {{time}} - {{subject}}",
			get: () => this.plugin.settings.noteFilenameTemplate,
			set: v => { this.plugin.settings.noteFilenameTemplate = v; },
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
			name: "Transcripts folder",
			desc: "Vault folder where transcript files are created when linking recordings",
			placeholder: "Transcripts",
			get: () => this.plugin.settings.transcriptFolderPath,
			set: v => { this.plugin.settings.transcriptFolderPath = v; },
			suggest: "folder",
			browse: true,
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

		this.addSubHeading(containerEl, "People");

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
			desc: "Automatically create people notes for meeting organizers without one (requires a people template). Newly-tagged speakers always get a note so voiceprints stay aligned.",
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
	}

	/** Recording tab — capture source and its source-specific knobs. */
	private renderRecordingTab(containerEl: HTMLElement): void {
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

		new Setting(apiSettings)
			.setName("Test API")
			.setDesc("Check that the recording app is reachable by querying its status endpoint")
			.addButton(button => button
				.setButtonText("Test API")
				.onClick(async () => {
					const baseUrl = resolveRecordingApiBaseUrl(this.plugin.settings.recordingApiBaseUrl);
					if (!baseUrl) {
						new Notice("Recording API is not configured. Set a base URL or start the recording app.");
						return;
					}
					button.setDisabled(true);
					const original = button.buttonEl.textContent;
					button.setButtonText("Testing…");
					try {
						const status = await recordingStatus(baseUrl);
						new Notice(`Recording app is available (state: ${status.state}).`);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						new Notice(`Recording API test failed: ${msg}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText(original ?? "Test API");
					}
				}));

		new Setting(apiSettings)
			.setName("Automate meeting recording")
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("Clicking a meeting's join link on its calendar card starts recording automatically, and stopping that recording from WhisperCal closes the meeting app (Teams, Zoom) to leave the call.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.automateMeetingRecording)
				.onChange(value => {
					this.plugin.settings.automateMeetingRecording = value;
					this.debouncedSave();
				}));

		updateRecordingVisibility();
	}

	/** Speakers tab — voiceprint matching, the LLM fallback prompt, and modal knobs. */
	private renderSpeakersTab(containerEl: HTMLElement): void {
		 
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

		this.addFloatSetting({
			container: containerEl,
			name: "Voiceprint match floor",
			desc: "Minimum cosine similarity (0–1) required to accept an acoustic speaker match. " +
				"Higher is stricter: fewer false matches, but more speakers left for you to confirm by ear. " +
				"Default 0.50. Solo-library matches always use at least 0.55.",
			placeholder: "0.50",
			min: 0,
			max: 1,
			get: () => this.plugin.settings.voiceprintMatchFloor,
			set: v => { this.plugin.settings.voiceprintMatchFloor = v; },
		});

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

		this.addFloatSetting({
			container: autoTagSkipSub,
			name: "Auto-tag confidence floor",
			desc: "Minimum cosine similarity (0–1) every speaker must reach for the modal to be skipped. " +
				"Keep it high so unattended tagging stays strict. Default 0.80.",
			placeholder: "0.80",
			min: 0,
			max: 1,
			get: () => this.plugin.settings.voiceprintAutoTagFloor,
			set: v => { this.plugin.settings.voiceprintAutoTagFloor = v; },
		});

		this.addFloatSetting({
			container: autoTagSkipSub,
			name: "Ignore minor speakers",
			desc: "Diarizers often emit a junk speaker for crosstalk or stray utterances that never " +
				"voiceprint-matches and would block auto-tagging. An unmatched speaker with at most this " +
				"share of transcript lines (0–1) no longer blocks — it is left untagged, as you would in " +
				"the modal. Default 0.05 (5%). Set 0 to require every speaker to match.",
			placeholder: "0.05",
			min: 0,
			max: 1,
			get: () => this.plugin.settings.voiceprintAutoTagMinorMaxShare,
			set: v => { this.plugin.settings.voiceprintAutoTagMinorMaxShare = v; },
		});
		autoTagSkipSub.toggle(this.plugin.settings.voiceprintAutoTagSkipModal);

		this.addPromptGroup(
			containerEl,
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
		 
	}

	/** Summary & research tab — the two note-producing prompts and their inputs. */
	private renderSummaryTab(containerEl: HTMLElement): void {
		 
		this.addPromptGroup(
			containerEl,
			"Summarizer",
			"Vault-relative or absolute path to the Claude Code prompt file for summarizing transcripts (e.g. Prompts/Meeting Summarizer.md)",
			"Prompts/Meeting Summarizer.md",
			"summarizerPromptPath",
			"summarizerModel",
			"summarizerFlags",
		);

		this.addPromptGroup(
			containerEl,
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
		 
	}

	/** LLM engine tab — the shared plumbing every prompt runs on. */
	private renderLlmTab(containerEl: HTMLElement): void {
		/* eslint-disable obsidianmd/ui/sentence-case */
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
				"tag speakers in the background and cache the candidates (the card's action button turns into " +
				"\"Review speakers\" when they're ready — tags are never applied without your confirmation), then " +
				"start summarization after you apply them. Single-mic recordings are skipped. " +
				"Off = the card's action button steps through each stage (Tag speakers, Summarize) manually.",
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

		// ── Shared LLM engine — owned by WhisperCore ──
		// The CLI command, shared flags, API key, prompt directory, timeout,
		// concurrency cap, and debug toggles all live in WhisperCore now (read via
		// getLlmConfig), so the family shares one source of truth. WhisperCal shows
		// them read-only here with a jump to Core to change them; only the product
		// controls above (enable + automatic mode) stay editable in WhisperCal.
		this.renderCoreLlmMirror(containerEl);
		/* eslint-enable obsidianmd/ui/sentence-case */
	}

	/**
	 * Read-only mirror of the shared LLM engine settings that WhisperCore owns
	 * (getLlmConfig), with a single jump to Core's settings tab to change them.
	 * Snapshot at display time — reopen the tab to pick up edits made in Core.
	 * Collapses to the install gate when Core is absent (DESIGN §8.4).
	 */
	private renderCoreLlmMirror(containerEl: HTMLElement): void {
		this.addSubHeading(containerEl, "LLM engine");

		const api = getWhisperCoreApi(this.app);
		if (!api) {
			containerEl.createDiv({
				cls: "whisper-cal-settings-warning",

				text: "WhisperCore required — install and enable the WhisperCore plugin to configure the shared LLM engine.",
			});
			return;
		}

		// Same "Managed in WhisperCore" card as the calendar section: banner + the
		// read-only values Core vends, in one shaded box.
		const llm = api.getLlmConfig();
		this.renderCoreManagedCard(containerEl, [
			["Prompt directory", llm.promptDir || "Not set"],
			["CLI command", llm.cli || "claude (default)"],
			["Shared flags", llm.extraFlags || "None"],
			["Anthropic API key", llm.anthropicApiKey ? "Set" : "Not set"],
			["LLM timeout", llm.timeoutMinutes > 0 ? `${llm.timeoutMinutes} min` : "No timeout"],
			["Max concurrent processes", String(llm.maxConcurrent)],
			["Debug mode", llm.debugMode ? "On" : "Off"],
			["Debug logging", llm.debugLogging ? "On" : "Off"],
		]);
	}

	/**
	 * Render one prompt group (Prompt path / Model / Additional flags) into a
	 * tab. Each model select registers in modelSelects so refreshModels() can
	 * populate it regardless of which tab is active.
	 */
	private addPromptGroup(
		container: HTMLElement,
		name: string,
		promptDesc: string,
		placeholder: string,
		pathKey: "speakerTaggingPromptPath" | "summarizerPromptPath" | "researchPromptPath",
		modelKey: "speakerTagModel" | "summarizerModel" | "researchModel",
		flagsKey: "speakerTagFlags" | "summarizerFlags" | "researchFlags",
	): void {
		 
		this.addSubHeading(container, name);

		new Setting(container)
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

		new Setting(container)
			.setName("Model")
			.setDesc(`Claude model for ${name.toLowerCase()}. Set the API key on the LLM engine tab to load available models.`)
			.addDropdown(dropdown => {
				this.modelSelects.push({sel: dropdown.selectEl, key: modelKey});
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
			container,
			name: "Additional flags",
			desc: `Extra CLI flags for ${name.toLowerCase()} only, appended after the global flags on the LLM engine tab (e.g. --effort medium). Leave empty to use only the global flags.`,
			placeholder: "--effort medium",
			get: () => this.plugin.settings[flagsKey],
			set: v => { this.plugin.settings[flagsKey] = v; },
		});
		 
	}

	/** Populate all registered model dropdowns from the API. */
	private async refreshModels(): Promise<void> {
		const models = await this.fetchAnthropicModels();
		for (const {sel, key} of this.modelSelects) {
			const current = this.plugin.settings[key];
			sel.replaceChildren();
			sel.add(new Option("Default", ""));
			for (const m of models) {
				sel.add(new Option(m.display_name, m.id));
			}
			sel.value = current;
		}
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
			// Key comes from WhisperCore now (C4); env var stays as a fallback.
			const coreKey = getWhisperCoreApi(this.app)?.getLlmConfig().anthropicApiKey ?? null;
			const apiKey = coreKey || globalThis.process?.env?.["ANTHROPIC_API_KEY"];
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

	/**
	 * Provider section body (DESIGN §8.4): the shared "Managed in WhisperCore"
	 * banner, then one subsection with everything WhisperCal uses for calendar
	 * provider functionality — the provider choice, the connection state (with a
	 * Sign in / Sign out button delegating through the API, so routine auth never
	 * leaves WhisperCal), and the read-only values it pulls from Core (Microsoft
	 * cloud instance + Graph endpoint). Collapses to the install gate when Core is
	 * absent. Re-renders on every auth-state change.
	 */
	private renderConnectionStatus(containerEl: HTMLElement): void {
		const block = containerEl.createDiv({cls: "whisper-cal-core-status"});
		const render = () => {
			block.empty();
			const api = getWhisperCoreApi(this.app);
			if (!api) {
				block.createDiv({
					cls: "whisper-cal-settings-warning",
					 
					text: "WhisperCore required — install and enable the WhisperCore plugin to connect your calendar and configure the LLM.",
				});
				return;
			}

			const provider = this.plugin.settings.calendarProvider;
			const providerLabel = provider === "microsoft" ? "Microsoft 365" : "Google Calendar";
			const info = api.getConnectionInfo(provider);

			// Everything WhisperCal uses for calendar provider functionality, read from
			// Core, as a read-only key:value list inside the "Managed in WhisperCore"
			// card. The provider itself is not selectable here — it is managed in
			// WhisperCore. Sign-in is not offered here either; connect from the sidebar
			// calendar banner or in WhisperCore (§8.2).
			let statusText: string;
			if (!info.configured) {
				statusText = provider === "microsoft"
					? "Not configured — set tenant and client id in WhisperCore"
					: "Not configured — set client id and secret in WhisperCore";
			} else if (info.state === "signed-in") {
				statusText = "Signed in";
			} else if (info.state === "signing-in") {
				statusText = info.message ?? "Signing in…";
			} else if (info.state === "error") {
				statusText = info.message ?? "Sign-in error";
			} else {
				statusText = "Signed out";
			}

			const pairs: Array<[string, string]> = [
				["Calendar provider", providerLabel],
				["Status", statusText],
			];
			if (provider === "microsoft") {
				pairs.push(["Cloud instance", info.cloudInstance || "—"]);
				pairs.push(["Graph endpoint", info.graphBaseUrl || "—"]);
			}
			this.renderCoreManagedCard(block, pairs);
		};

		render();
		// Re-render on any auth transition (driven by main's whispercore:auth-changed
		// and whispercore:ready bridges through onAuthStateChange).
		this.authUnsubscribe = this.plugin.onAuthStateChange(() => render());
	}

	/**
	 * The "Managed in WhisperCore" block: the banner header (name/desc + Open button)
	 * and the read-only key:value list of Core-owned values, rendered as ONE native
	 * Obsidian `.setting-item` so the theme styles it exactly like every other
	 * settings section (no custom shaded box that reads a different shade). The list
	 * wraps full-width below the header row via CSS. Rendered identically across every
	 * Core-owned section and mirrored in WhisperOrg. Assumes Core is present (callers
	 * gate on getWhisperCoreApi and show the install note when it is not).
	 */
	private renderCoreManagedCard(containerEl: HTMLElement, pairs: Array<[string, string]>): void {
		const setting = new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- product name
			.setName("Managed in WhisperCore")
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- product names
			.setDesc("These settings are configured in WhisperCore and shared across the Whisper plugins. Open WhisperCore to view or change them.")
			.addButton(b => b
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- product name
				.setButtonText("Open WhisperCore settings")
				.setCta()
				.onClick(() => this.openCoreSettings()));
		setting.settingEl.addClass("whisper-cal-managed-item");
		this.renderKeyValueList(setting.settingEl, pairs);
	}

	/** Render a compact, read-only key:value list — used for the values WhisperCal
	 *  pulls from WhisperCore for the selected calendar provider. */
	private renderKeyValueList(containerEl: HTMLElement, pairs: Array<[string, string]>): void {
		const list = containerEl.createDiv({cls: "whisper-cal-kv-list"});
		for (const [key, value] of pairs) {
			const row = list.createDiv({cls: "whisper-cal-kv-row"});
			row.createSpan({cls: "whisper-cal-kv-key", text: key});
			row.createSpan({cls: "whisper-cal-kv-value", text: value});
		}
	}

	/** Open WhisperCore's settings tab directly. `app.setting` is community-standard
	 *  but unofficial (same status as `app.plugins`) — optional-chain and fall back
	 *  to a Notice. */
	private openCoreSettings(): void {
		const appWithSetting = this.app as unknown as {setting?: {open(): void; openTabById(id: string): void}};
		if (appWithSetting.setting?.open && appWithSetting.setting?.openTabById) {
			appWithSetting.setting.open();
			appWithSetting.setting.openTabById("whispercore");
		} else {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- Settings menu + product name
			new Notice("Open Settings → WhisperCore");
		}
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
				addActivateOnKey(removeBtn);
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
}
