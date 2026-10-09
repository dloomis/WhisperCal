import {App, Modal, Notice, Platform, PluginSettingTab, Setting, normalizePath} from "obsidian";
import type {SettingDefinitionGroup, SettingDefinitionItem, SettingGroupItem} from "obsidian";
import type WhisperCalPlugin from "./main";
import type {CalendarProviderType} from "./types";
import type {CloudInstance} from "./services/auth/AuthTypes";
import {CLOUD_INSTANCE_OPTIONS} from "./services/auth/AuthTypes";
import type {AuthState} from "./services/CalendarAuth";
import {listAnthropicModels, resolveAnthropicKey} from "./services/AnthropicModels";
import type {AnthropicModel} from "./services/AnthropicModels";
import {MACWHISPER_DB_PATH} from "./constants";
import {DEFAULT_MATCH_FLOOR} from "./services/VoiceprintMatcher";
import {addActivateOnKey} from "./utils/a11y";
import {recordingStatus, resolveRecordingApiBaseUrl} from "./services/RecordingApi";
import type {PersistedApiRecording} from "./services/ApiRecording";
import {FileSuggest} from "./ui/FileSuggest";
import type {PeopleSearchResult} from "./services/PeopleSearchProvider";

interface ImportantOrganizer {
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
	// Microsoft 365 auth config
	tenantId: string;
	clientId: string;
	cloudInstance: CloudInstance;
	// Google auth config
	googleClientId: string;
	googleClientSecret: string;
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
	/** One-shot marker: the OS-account probe that pre-fills microphoneUser has
	 *  run. Lets a deliberately-cleared field STAY empty across restarts. */
	micUserProbed: boolean;
	rosterMaxEnriched: number;
	speakerTagClipSeconds: number;
	llmEnabled: boolean;
	llmCli: string;
	llmExtraFlags: string;
	/** Used only to populate the model dropdowns — never sent to the CLI. */
	anthropicApiKey: string;
	/** Shared vault folder holding LLM prompt files ("" when unset). */
	llmPromptDir: string;
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
	/**
	 * Tie recording to the meeting's lifecycle: clicking a meeting's join link on
	 * its calendar card starts recording automatically, and stopping that
	 * recording from WhisperCal closes the meeting app (Teams, Zoom) to leave the
	 * call. Recording API source only. Migrated from the old `autoRecordOnLaunch`.
	 */
	automateMeetingRecording: boolean;
	/**
	 * Pull the Teams meeting chat into the meeting note under a "Meeting Chat"
	 * heading once a recording's link tail finishes. Microsoft provider only,
	 * and needs the delegated Chat.Read scope on the Microsoft token — without
	 * it the automatic pull logs and stays silent (the manual re-pull explains).
	 */
	pullMeetingChat: boolean;
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
	/** Legacy flag from the 0.8.x releases that kept auth + LLM config in the
	 *  WhisperCore plugin: true when this install handed its config off to Core.
	 *  Read only by the one-time import back out of Core. */
	coreMigrationDone: boolean;
	/** Set once the one-time import of provider config, tokens, and LLM config
	 *  from WhisperCore's data.json has run. Internal flag, not user-facing. */
	coreImportDone: boolean;
	/** Fingerprint of the importable settings taken when the WhisperCore import
	 *  was first deferred (unreadable data.json); empty otherwise. Internal. */
	coreImportDeferredFingerprint: string;
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
	micUserProbed: false,
	rosterMaxEnriched: 20,
	speakerTagClipSeconds: 5,
	llmEnabled: false,
	llmCli: "claude",
	llmExtraFlags: "--dangerously-skip-permissions",
	anthropicApiKey: "",
	llmPromptDir: "",
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
	automateMeetingRecording: false,
	pullMeetingChat: true,
	skipWordReplacementConfirm: false,
	voiceprintFolderPath: "Caches/Voiceprints",
	voiceprintMatchFloor: DEFAULT_MATCH_FLOOR,
	voiceprintAutoTagSkipModal: false,
	voiceprintAutoTagFloor: 0.80,
	voiceprintAutoTagMinorMaxShare: 0.05,
	coreMigrationDone: false,
	coreImportDone: false,
	coreImportDeferredFingerprint: "",
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

type SettingKey = keyof WhisperCalSettings;
type KeysOfType<T> = {[P in SettingKey]: WhisperCalSettings[P] extends T ? P : never}[SettingKey];
type Row = SettingGroupItem<SettingKey>;
type ModelKey = "speakerTagModel" | "summarizerModel" | "researchModel";

interface RowOpts {
	name: string;
	desc?: string;
	aliases?: string[];
	visible?: () => boolean;
}

const OAUTH_TOKEN_WARNING = "OAuth tokens are stored unencrypted in this vault's plugin data folder. Avoid syncing the data file to untrusted services; revoke access from the provider's account portal if the file is exposed.";

/** Folder settings: a stray trailing slash or "./" would break consumers like
 *  `startsWith(folder + "/")`. Empty stays empty — for folder settings that
 *  means "disabled", which normalizePath would otherwise turn into "/". */
const normalizeFolder = (v: string): string => v.trim() ? normalizePath(v) : "";
const trim = (v: string): string => v.trim();

/**
 * Declarative settings tab (Obsidian 1.13+). `getSettingDefinitions()` describes
 * the settings; Obsidian renders them, indexes them for settings search, and
 * handles sub-page navigation. Rows that need side effects or custom DOM
 * (consent flow, auth status, model dropdowns, the organizer chip field) use
 * `render` and save themselves.
 */
export class WhisperCalSettingTab extends PluginSettingTab {
	plugin: WhisperCalPlugin;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private searchTimer: number | null = null;
	/** Free-text keys and how to normalize what was typed before storing it.
	 *  Membership also means "save debounced" — these fire on every keystroke. */
	private textKeys = new Map<string, (v: string) => string>();
	/** Repaints the Connection row; set only while that row is on screen. */
	private repaintAuth: (() => void) | null = null;
	/** Model dropdowns currently on screen, repopulated when the model list loads. */
	private modelSelects: {sel: HTMLSelectElement; key: ModelKey}[] = [];
	private models: AnthropicModel[] = [];
	/** API key the model list was (or is being) fetched with; null = not fetched. */
	private modelsFetchedFor: string | null = null;
	/** Sequence number of the latest model fetch; older responses are dropped. */
	private modelRefreshSeq = 0;

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

	/** Untyped write for keys only known at runtime (or generic over the key). */
	private store(key: string, value: unknown): void {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	/**
	 * Every `control` row writes through here. Must not fall through to the
	 * default implementation: that calls `saveData(settings)`, which would
	 * replace data.json with the bare settings object and drop the token caches
	 * (`persistData()` in main.ts is the single writer).
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		const normalize = this.textKeys.get(key);
		if (normalize && typeof value === "string") {
			this.store(key, normalize(value));
			this.debouncedSave();
			return;
		}
		this.store(key, value);
		await this.plugin.saveSettings();
		// The save rebuilt the provider stack — show the new provider's auth state.
		if (key === "calendarProvider") this.repaintAuth?.();
	}

	hide(): void {
		if (this.searchTimer !== null) {
			window.clearTimeout(this.searchTimer);
			this.searchTimer = null;
		}
		// Refetch the model list the next time settings are opened.
		this.modelsFetchedFor = null;
		// Flush any pending debounced save so settings aren't lost
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			void this.plugin.saveSettings();
		}
	}

	// ── Row builders ──────────────────────────────────────────────────────

	private textRow(key: KeysOfType<string>, o: RowOpts & {
		placeholder?: string;
		normalize?: (v: string) => string;
		validate?: (v: string) => string | void;
	}): Row {
		this.textKeys.set(key, o.normalize ?? (v => v));
		return {
			name: o.name, desc: o.desc, aliases: o.aliases, visible: o.visible,
			control: {type: "text", key, placeholder: o.placeholder, validate: o.validate},
		};
	}

	private folderRow(key: KeysOfType<string>, o: RowOpts & {placeholder?: string}): Row {
		this.textKeys.set(key, normalizeFolder);
		return {
			name: o.name, desc: o.desc, aliases: o.aliases, visible: o.visible,
			control: {type: "folder", key, placeholder: o.placeholder},
		};
	}

	/** Vault markdown file picker (native combobox). */
	private fileRow(key: KeysOfType<string>, o: RowOpts): Row {
		return {
			name: o.name, desc: o.desc, aliases: o.aliases, visible: o.visible,
			control: {type: "file", key, filter: file => file.extension === "md"},
		};
	}

	private toggleRow(key: KeysOfType<boolean>, o: RowOpts): Row {
		return {
			name: o.name, desc: o.desc, aliases: o.aliases, visible: o.visible,
			control: {type: "toggle", key},
		};
	}

	/** Whole number, `min <= value` (default min=1). */
	private intRow(key: KeysOfType<number>, o: RowOpts & {min?: number}): Row {
		const min = o.min ?? 1;
		return {
			name: o.name, desc: o.desc, aliases: o.aliases, visible: o.visible,
			control: {
				type: "number", key, min, step: 1,
				placeholder: String(DEFAULT_SETTINGS[key]),
				defaultValue: DEFAULT_SETTINGS[key],
				validate: v => Number.isInteger(v) ? undefined : "Enter a whole number",
			},
		};
	}

	/** Fraction bounded to [0, 1]. */
	private ratioRow(key: KeysOfType<number>, o: RowOpts): Row {
		return {
			name: o.name, desc: o.desc, aliases: o.aliases, visible: o.visible,
			control: {
				type: "number", key, min: 0, max: 1, step: "any",
				placeholder: String(DEFAULT_SETTINGS[key]),
				defaultValue: DEFAULT_SETTINGS[key],
			},
		};
	}

	/** Masked text input. The declarative text control can't be a password field. */
	private secretRow(key: KeysOfType<string>, o: RowOpts & {placeholder: string}): Row {
		return {
			name: o.name, desc: o.desc, aliases: o.aliases, visible: o.visible,
			render: (setting) => {
				setting.addText(text => {
					text.inputEl.type = "password";
					text.setPlaceholder(o.placeholder)
						.setValue(this.plugin.settings[key])
						.onChange((value) => {
							this.store(key, value.trim());
							this.debouncedSave();
						});
				});
			},
		};
	}

	/**
	 * Free-text path input with vault-file suggestions. Used instead of the
	 * `file` control where the path may be absolute or name a file that doesn't
	 * exist yet — the native picker only offers existing vault files.
	 */
	private pathRow(
		key: KeysOfType<string>,
		o: RowOpts & {placeholder: string},
		extend?: (setting: Setting) => void,
	): Row {
		return {
			name: o.name, desc: o.desc, aliases: o.aliases, visible: o.visible,
			render: (setting) => {
				setting.addText(text => {
					text.setPlaceholder(o.placeholder)
						.setValue(this.plugin.settings[key])
						.onChange((value) => {
							this.store(key, value.trim());
							this.debouncedSave();
						});
					new FileSuggest(this.app, text.inputEl);
				});
				extend?.(setting);
			},
		};
	}

	// ── Definitions ───────────────────────────────────────────────────────

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = () => this.plugin.settings;
		// Sub-pages grouped by pipeline stage.
		const pages: Row[] = [
			{
				type: "page",
				name: "Calendar",
				desc: "Provider, account, and how the calendar is displayed",
				displayValue: () => s().calendarProvider === "microsoft" ? "Microsoft 365" : "Google Calendar",
				status: () => {
					const status = this.plugin.auth.getState().status;
					return status === "signed-out" || status === "error" ? "warning" : null;
				},
				items: this.calendarPage(),
			},
			{
				type: "page",
				name: "LLM engine",
				desc: "The shared plumbing every prompt runs on",
				displayValue: () => s().llmEnabled ? "On" : "Off",
				items: this.llmPage(),
			},
			{
				type: "page",
				name: "Notes & people",
				desc: "Where notes land and how they're templated",
				items: this.notesPage(),
			},
			{
				type: "page",
				name: "Recording",
				desc: "Capture source and its options",
				displayValue: () => s().recordingSource === "macwhisper" ? "MacWhisper" : "Recording API",
				items: this.recordingPage(),
			},
			{
				type: "page",
				name: "Speakers",
				desc: "Voiceprint matching and transcript post-processing",
				items: this.speakersPage(),
			},
			{
				type: "page",
				name: "Summary & research",
				desc: "The two note-producing prompts and their inputs",
				items: this.summaryPage(),
			},
		];
		return [
			{type: "group", cls: "whisper-cal-settings", items: pages},
			{
				type: "group",
				cls: "whisper-cal-settings",
				items: [{name: "Version", desc: this.plugin.manifest.version, searchable: false}],
			},
		];
	}

	/** Calendar page — provider + credentials, display options, refresh/cache. */
	private calendarPage(): SettingDefinitionItem<SettingKey>[] {
		const isMicrosoft = () => this.plugin.settings.calendarProvider === "microsoft";
		const isGoogle = () => !isMicrosoft();
		return [
			{
				type: "group",
				heading: "Provider",
				cls: "whisper-cal-settings",
				items: [
					{
						name: "Calendar provider",
						desc: "Which calendar service to connect to",
						control: {
							type: "dropdown",
							key: "calendarProvider",
							options: {microsoft: "Microsoft 365", google: "Google Calendar"},
						},
					},
					this.textRow("tenantId", {
						name: "Tenant ID",
						desc: "Directory (tenant) ID from Azure AD. Leave empty to auto-detect from your account.",
						placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
						normalize: trim,
						visible: isMicrosoft,
					}),
					this.textRow("clientId", {
						name: "Client ID",
						desc: "Application (client) ID from your Azure AD app registration",
						placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
						normalize: trim,
						visible: isMicrosoft,
					}),
					{
						name: "Cloud instance",
						desc: "Microsoft cloud environment (Public, USGov, USGovHigh, USGovDoD, China)",
						visible: isMicrosoft,
						control: {
							type: "dropdown",
							key: "cloudInstance",
							options: Object.fromEntries(CLOUD_INSTANCE_OPTIONS.map(o => [o, o])),
						},
					},
					this.textRow("googleClientId", {
						name: "Client ID",
						desc: "OAuth client ID from your Google Cloud Console desktop app credentials",
						placeholder: "xxxxxxxxxxxx.apps.googleusercontent.com",
						normalize: trim,
						visible: isGoogle,
					}),
					this.secretRow("googleClientSecret", {
						name: "Client secret",
						desc: "OAuth client secret from your Google Cloud Console desktop app credentials",
						placeholder: "GOCSPX-xxxxxxxxxxxxxxxxxxxx",
						visible: isGoogle,
					}),
					this.authRow(),
				],
			},
			{
				// General calendar settings (apply to both providers).
				type: "group",
				heading: "General",
				cls: "whisper-cal-settings",
				items: [
					this.textRow("timezone", {
						name: "Timezone",
						desc: "IANA timezone for displaying meeting times (e.g. America/New_York, Europe/London)",
						placeholder: "America/New_York",
						normalize: trim,
						validate: (v) => {
							try { Intl.DateTimeFormat(undefined, {timeZone: v.trim()}); return undefined; }
							catch { return "Not a valid IANA timezone"; }
						},
					}),
					{
						name: "Time format",
						desc: "How meeting times are displayed: 12-hour (9:00 AM), 24-hour (09:00), or auto-detect from system",
						control: {
							type: "dropdown",
							key: "timeFormat",
							options: {"auto": "Auto", "12h": "12-hour", "24h": "24-hour"},
						},
					},
					this.toggleRow("showAllDayEvents", {
						name: "Show all-day events",
						desc: "Display all-day events in the calendar view",
					}),
					{
						name: "Important organizers",
						desc: "Meetings organized by these people show an alert icon in the gutter",
						render: (setting) => {
							this.renderImportantOrganizers(setting);
							return () => {
								if (this.searchTimer !== null) {
									window.clearTimeout(this.searchTimer);
									this.searchTimer = null;
								}
							};
						},
					},
					this.intRow("refreshIntervalMinutes", {
						name: "Refresh interval (minutes)",
						desc: "How often to refresh the calendar view",
					}),
					this.intRow("cacheFutureDays", {
						name: "Cache future days",
						desc: "Number of upcoming days to pre-fetch for offline access",
						min: 0,
					}),
					this.intRow("cacheRetentionDays", {
						name: "Cache retention (days)",
						desc: "How many days of past calendar data to keep in the local cache",
					}),
				],
			},
		];
	}

	/** Sign-in status and its action button; repaints on every auth state change. */
	private authRow(): Row {
		return {
			name: "Connection",
			desc: "Sign in to or out of the selected calendar provider",
			aliases: ["Sign in", "Sign out", "Account"],
			render: (setting) => {
				const paint = (state: AuthState) => {
					setting.clear();
					let label: string;
					let labelCls = "";
					let hint: string | null = null;
					switch (state.status) {
					case "signed-out":
						label = "Not signed in";
						setting.addButton(btn => btn.setButtonText("Sign in").setCta()
							.onClick(() => { void this.plugin.auth.startSignIn(); }));
						break;
					case "signing-in":
						label = state.message ?? "Signing in…";
						hint = "Waiting for authorization…";
						setting.addButton(btn => btn.setButtonText("Cancel")
							.onClick(() => { this.plugin.auth.cancelSignIn(); }));
						break;
					case "signed-in":
						label = "Signed in";
						labelCls = "whisper-cal-auth-success";
						setting.addButton(btn => btn.setButtonText("Sign out")
							.onClick(() => { void this.plugin.auth.signOut(); }));
						break;
					case "error":
						label = state.message;
						labelCls = "whisper-cal-auth-error";
						setting.addButton(btn => btn.setButtonText("Try again").setCta()
							.onClick(() => { void this.plugin.auth.startSignIn(); }));
						break;
					}
					const frag = document.createDocumentFragment();
					frag.createDiv({cls: labelCls, text: label});
					if (hint) frag.createDiv({cls: "whisper-cal-auth-hint", text: hint});
					frag.createDiv({cls: "whisper-cal-settings-warning", text: OAUTH_TOKEN_WARNING});
					setting.setDesc(frag);
				};
				this.repaintAuth = () => paint(this.plugin.auth.getState());
				this.repaintAuth();
				const unsubscribe = this.plugin.onAuthStateChange(paint);
				return () => {
					unsubscribe();
					this.repaintAuth = null;
				};
			},
		};
	}

	/** Notes & people page — where notes land and how they're templated. */
	private notesPage(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				type: "group",
				heading: "Meeting notes",
				cls: "whisper-cal-settings",
				items: [
					this.folderRow("noteFolderPath", {
						name: "Notes folder",
						desc: "Vault folder where meeting notes are created",
						placeholder: "Meetings",
					}),
					this.textRow("noteFilenameTemplate", {
						name: "Note filename template",
						desc: "Template for meeting note filenames. Available: {{date}} (YYYY-MM-DD), {{time}} (HHmm, 24-hour), {{subject}}. Add {{time}} to keep two same-subject meetings on the same day in separate notes.",
						placeholder: "{{date}} {{time}} - {{subject}}",
					}),
					this.fileRow("noteTemplatePath", {
						name: "Note template",
						desc: "Vault file used as a template for meeting note content. Copy the sample template from the plugin's samples/ folder into your vault and pick it here.",
					}),
					this.textRow("unscheduledSubject", {
						name: "Unscheduled note subject",
						desc: "Subject used for ad-hoc meeting notes not tied to a calendar event",
						placeholder: "Unscheduled Meeting",
					}),
					this.folderRow("transcriptFolderPath", {
						name: "Transcripts folder",
						desc: "Vault folder where transcript files are created when linking recordings",
						placeholder: "Transcripts",
					}),
					this.pathRow("replacementFilePath", {
						name: "Word replacement file",
						desc: "Vault path to a word replacement file applied to transcripts after speaker tagging (one per line: search,replace)",
						placeholder: "Prompts/Word Replacements.md",
					}, (setting) => { setting.addButton(button => button
						.setButtonText("Open")
						.onClick(async () => {
							const filePath = normalizePath(this.plugin.settings.replacementFilePath);
							if (!filePath) {
								return;
							}
							try {
								if (!this.app.vault.getAbstractFileByPath(filePath)) {
									const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
									if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
										await this.app.vault.createFolder(dir);
									}
									await this.app.vault.create(filePath, "# Word replacements (one per line: search,replace)\n");
								}
							} catch (e) {
								new Notice(`Could not create ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
								return;
							}
							void this.app.workspace.openLinkText(filePath, "", false);
						})); }),
				],
			},
			{
				type: "group",
				heading: "People",
				cls: "whisper-cal-settings",
				items: [
					this.folderRow("peopleFolderPath", {
						name: "People folder",
						desc: "Vault folder containing people notes. Matched attendees render as [[wiki links]] in meeting notes.",
						placeholder: "People",
					}),
					this.toggleRow("autoCreatePeopleNotes", {
						name: "Auto-create people notes",
						desc: "Automatically create people notes for meeting organizers without one (requires a people template). Newly-tagged speakers always get a note so voiceprints stay aligned.",
					}),
					this.fileRow("peopleTemplatePath", {
						name: "People template",
						desc: "Vault file used as a template for auto-created people notes. Available: {{full_name}}, {{nickname}}, {{email}}, {{organization}}",
					}),
				],
			},
		];
	}

	/** Recording page — capture source and its source-specific knobs. */
	private recordingPage(): SettingDefinitionItem<SettingKey>[] {
		const isMacWhisper = () => this.plugin.settings.recordingSource === "macwhisper";
		const isApi = () => !isMacWhisper();
		const sources: Record<string, string> = {};
		if (Platform.isMacOS) sources["macwhisper"] = "MacWhisper";
		sources["api"] = "Recording API";
		return [
			{
				type: "group",
				cls: "whisper-cal-settings",
				items: [{
					name: "Source",
					desc: "Choose how meeting recordings are captured",
					aliases: ["Recording source"],
					control: {type: "dropdown", key: "recordingSource", options: sources},
				}],
			},
			{
				type: "group",
				heading: "MacWhisper",
				cls: "whisper-cal-settings",
				visible: isMacWhisper,
				items: [
					{name: "Database path", desc: MACWHISPER_DB_PATH, visible: isMacWhisper},
					this.intRow("recordingWindowMinutes", {
						name: "Recording match window (minutes)",
						desc: "How close a recording start must be to the scheduled meeting time to be matched automatically (manual linking offers the whole day)",
						visible: isMacWhisper,
					}),
					this.intRow("unlinkedLookbackDays", {
						name: "Unlinked lookback (days)",
						desc: "How far back to check for unlinked recordings",
						visible: isMacWhisper,
					}),
				],
			},
			{
				type: "group",
				heading: "Recording API",
				cls: "whisper-cal-settings",
				visible: isApi,
				items: [
					this.textRow("recordingApiBaseUrl", {
						name: "Base URL",
						desc: "REST API base URL (e.g. http://127.0.0.1:8080/api/v1). Expects /health, /start, /stop, /status endpoints.",
						placeholder: "http://127.0.0.1:8080/api/v1",
						normalize: v => v.trim().replace(/\/+$/, ""),
						visible: isApi,
					}),
					{
						name: "Test API",
						desc: "Check that the recording app is reachable by querying its status endpoint",
						visible: isApi,
						render: (setting) => {
							setting.addButton(button => button
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
						},
					},
					this.toggleRow("automateMeetingRecording", {
						name: "Automate meeting recording",
						desc: "Clicking a meeting's join link on its calendar card starts recording automatically, and stopping that recording from WhisperCal closes the meeting app (Teams, Zoom) to leave the call.",
						visible: isApi,
					}),
					this.toggleRow("pullMeetingChat", {
						name: "Pull Teams meeting chat",
						desc: "When a recording finishes, add the meeting's Teams chat to the meeting note under a \"Meeting Chat\" heading. Microsoft calendars only, and your sign-in must include the Chat.Read permission — sign out and back in after granting it. Re-pull any time from a card's ⋯ menu.",
						visible: isApi,
					}),
				],
			},
		];
	}

	/** Speakers page — voiceprint matching, the LLM fallback prompt, and modal knobs. */
	private speakersPage(): SettingDefinitionItem<SettingKey>[] {
		// Auto-tag sub-settings are only shown while the feature is on.
		const autoTagOn = () => this.plugin.settings.voiceprintAutoTagSkipModal;
		return [
			{
				type: "group",
				heading: "Voiceprints",
				cls: "whisper-cal-settings",
				items: [
					this.folderRow("voiceprintFolderPath", {
						name: "Speaker voiceprints folder",
						desc: "Vault folder where per-speaker voice embeddings are stored for acoustic speaker matching. Populated when you apply speaker tags to a transcript that has a voiceprint sidecar (.voiceprints.json) next to it.",
						placeholder: "Caches/Voiceprints",
					}),
					this.ratioRow("voiceprintMatchFloor", {
						name: "Voiceprint match floor",
						desc: "Minimum cosine similarity (0–1) required to accept an acoustic speaker match. " +
							"Higher is stricter: fewer false matches, but more speakers left for you to confirm by ear. " +
							"Default 0.50. Solo-library matches always use at least 0.55.",
					}),
					// Auto-tag (skip the modal) — silently apply tags when every speaker is a
					// confident voiceprint match. Drift guard: silent auto-tags never enroll or
					// update a library; that only happens when you confirm in the modal.
					this.toggleRow("voiceprintAutoTagSkipModal", {
						name: "Auto-tag when all speakers match",
						desc: "Skip the speaker-tagging modal and apply tags automatically when every speaker is a " +
							"confident voiceprint match at or above the floor below. Voiceprint libraries are never " +
							"updated on a silent auto-tag — only confirming in the modal enrolls or corrects them.",
					}),
					this.ratioRow("voiceprintAutoTagFloor", {
						name: "Auto-tag confidence floor",
						desc: "Minimum cosine similarity (0–1) every speaker must reach for the modal to be skipped. " +
							"Keep it high so unattended tagging stays strict. Default 0.80.",
						visible: autoTagOn,
					}),
					this.ratioRow("voiceprintAutoTagMinorMaxShare", {
						name: "Ignore minor speakers",
						desc: "Diarizers often emit a junk speaker for crosstalk or stray utterances that never " +
							"voiceprint-matches and would block auto-tagging. An unmatched speaker with at most this " +
							"share of transcript lines (0–1) no longer blocks — it is left untagged, as you would in " +
							"the modal. Default 0.05 (5%). Set 0 to require every speaker to match.",
						visible: autoTagOn,
					}),
				],
			},
			this.promptGroup(
				"Transcript post-processing",
				"Path to the prompt that fixes transcription and diarization errors in the transcript and proposes names for speakers voiceprints didn't match (e.g. Prompts/Transcript Post-Processing Prompt.md). Leave empty to skip the LLM step — known people are still matched by voiceprint and unknowns confirmed by ear in the modal.",
				"speakerTaggingPromptPath",
				"speakerTagModel",
				"speakerTagFlags",
				[
					this.textRow("microphoneUser", {
						name: "Microphone user",
						desc: "Your full name as it appears in meeting notes — passed to the LLM to identify your voice in transcripts",
						placeholder: "Full name",
					}),
					this.intRow("rosterMaxEnriched", {
						name: "Roster enrichment cap",
						desc: "Maximum number of meeting invitees to enrich with People note context for speaker tagging. Larger meetings pass all names but only enrich up to this many.",
					}),
					this.intRow("speakerTagClipSeconds", {
						name: "Speaker clip length (seconds)",
						desc: "When you click a timestamp in the speaker tagging modal, how many seconds of audio to play before stopping. 0 falls back to 5.",
						min: 0,
					}),
				],
			),
		];
	}

	/** Summary & research page — the two note-producing prompts and their inputs. */
	private summaryPage(): SettingDefinitionItem<SettingKey>[] {
		return [
			this.promptGroup(
				"Summarizer",
				"Vault-relative or absolute path to the Claude Code prompt file for summarizing transcripts (e.g. Prompts/Meeting Transcript Summarizer Prompt.md)",
				"summarizerPromptPath",
				"summarizerModel",
				"summarizerFlags",
			),
			this.promptGroup(
				"Research",
				"Vault-relative or absolute path to the Claude Code prompt file for meeting research (e.g. Prompts/Meeting Research Prompt.md)",
				"researchPromptPath",
				"researchModel",
				"researchFlags",
				[
					this.folderRow("seriesNotesFolderPath", {
						name: "Meeting series notes folder",
						desc: "Vault folder of per-series notes for recurring meetings. Each note holds bespoke research instructions (under a '## Research instructions' heading) that pre-fill the Research modal for that series. Leave empty to disable.",
						placeholder: "Meeting Series",
					}),
				],
			),
		];
	}

	/** LLM engine page — the shared plumbing every prompt runs on. */
	private llmPage(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				type: "group",
				cls: "whisper-cal-settings",
				items: [
					{
						name: "Enable LLM features",
						desc: "Allow speaker tagging and summarization via a cloud LLM. Enabling this may send meeting content to external services.",
						render: (setting) => {
							setting.addToggle(toggle => {
								let handling = false;
								toggle.setValue(this.plugin.settings.llmEnabled);
								toggle.onChange(async (value) => {
									if (handling) {
										// A click while the consent modal is pending already flipped the
										// DOM — snap it back to the stored setting so they can't desync.
										// (Guarded so the nested onChange from setValue can't recurse.)
										if (toggle.getValue() !== this.plugin.settings.llmEnabled) {
											toggle.setValue(this.plugin.settings.llmEnabled);
										}
										return;
									}
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
						},
					},
					// Automatic mode — repurposes the autoSummarizeAfterTagging key (same
					// key, existing installs keep their value) as the switch for the whole
					// automatic workflow: background auto-tag + auto-summarize after apply.
					this.toggleRow("autoSummarizeAfterTagging", {
						name: "Automatic mode",
						desc: "Run the LLM workflow automatically: when a transcript is linked to a meeting note, " +
							"tag speakers in the background and cache the candidates (the card's action button turns into " +
							"\"Review speakers\" when they're ready — tags are never applied without your confirmation), then " +
							"start summarization after you apply them. Single-mic recordings are skipped. " +
							"Off = the card's action button steps through each stage (Tag speakers, Summarize) manually.",
					}),
					this.intRow("autoTagLookbackHours", {
						name: "Auto-tag catch-up window (hours)",
						desc: "On startup, also auto-tag eligible transcripts created within this many hours. 0 disables the startup scan.",
						min: 0,
						visible: () => this.plugin.settings.autoSummarizeAfterTagging,
					}),
				],
			},
			{
				// Shared invocation settings that apply to every prompt.
				type: "group",
				heading: "LLM engine",
				cls: "whisper-cal-settings",
				items: [
					this.textRow("llmCli", {
						name: "CLI command",
						desc: "Command used to invoke the LLM (default: claude)",
						placeholder: "claude",
						normalize: v => v.trim() || "claude",
					}),
					this.textRow("llmExtraFlags", {
						name: "Additional flags (all prompts)",
						desc: "Extra CLI flags appended to every LLM command. " +
							"⚠️ The default --dangerously-skip-permissions is required for " +
							"non-interactive LLM usage — removing it will break speaker tagging " +
							"and summarization. Trust boundary: with this flag the CLI can read " +
							"and write files with no confirmation, and prompts include third-party " +
							"content (transcribed audio, attendee names, invite subjects) that could " +
							"contain injection attempts. Only run against meetings and an LLM you trust. " +
							"Use the per-prompt flags for task-specific options.",
						placeholder: "--dangerously-skip-permissions",
					}),
					this.secretRow("anthropicApiKey", {
						name: "Anthropic API key",
						desc: "Used to populate model dropdowns. Not sent to the CLI — the CLI uses its own auth.",
						placeholder: "sk-ant-...",
					}),
					this.intRow("llmTimeoutMinutes", {
						name: "LLM timeout (minutes)",
						desc: "Kill the LLM process if it runs longer than this (0 = no timeout). Transcript post-processing reads and rewrites the whole transcript, so give it headroom.",
						min: 0,
					}),
					this.intRow("llmMaxConcurrent", {
						name: "Max concurrent LLM processes",
						desc: "Maximum number of LLM processes that can run simultaneously",
					}),
				],
			},
			{
				type: "group",
				heading: "Troubleshooting",
				cls: "whisper-cal-settings",
				items: [
					this.toggleRow("llmDebugMode", {
						name: "Debug mode",
						desc: "Open LLM commands in a terminal window instead of running in the background",
						visible: () => Platform.isMacOS || Platform.isWin,
					}),
					this.toggleRow("llmDebugLogging", {
						name: "Debug logging",
						desc: "Log detailed diagnostics — LLM commands and stdout, speaker tagging, and voiceprint enrollment — to the developer console (Cmd+Opt+I / Ctrl+Shift+I). Off by default to avoid leaking meeting content.",
					}),
				],
			},
		];
	}

	/**
	 * One prompt group (Prompt path / Model / Additional flags), plus any rows
	 * that belong with that prompt.
	 */
	private promptGroup(
		name: string,
		promptDesc: string,
		pathKey: "speakerTaggingPromptPath" | "summarizerPromptPath" | "researchPromptPath",
		modelKey: ModelKey,
		flagsKey: "speakerTagFlags" | "summarizerFlags" | "researchFlags",
		extra: Row[] = [],
	): SettingDefinitionGroup<SettingKey> {
		const lower = name.toLowerCase();
		return {
			type: "group",
			heading: name,
			cls: "whisper-cal-settings",
			items: [
				this.pathRow(pathKey, {
					name: "Prompt",
					desc: promptDesc,
					placeholder: DEFAULT_SETTINGS[pathKey],
					aliases: [`${name} prompt`],
				}),
				{
					name: "Model",
					desc: `Claude model for ${lower}. Set the API key on the LLM engine page to load available models.`,
					aliases: [`${name} model`],
					render: (setting) => {
						const entry = {sel: null as unknown as HTMLSelectElement, key: modelKey};
						setting.addDropdown(dropdown => {
							entry.sel = dropdown.selectEl;
							this.fillModelSelect(entry.sel, modelKey);
							dropdown.onChange(async (value) => {
								this.plugin.settings[modelKey] = value;
								await this.plugin.saveSettings();
							});
						});
						this.modelSelects.push(entry);
						void this.loadModels();
						return () => {
							this.modelSelects = this.modelSelects.filter(e => e !== entry);
						};
					},
				},
				this.textRow(flagsKey, {
					name: "Additional flags",
					desc: `Extra CLI flags for ${lower} only, appended after the global flags on the LLM engine page (e.g. --effort medium). Leave empty to use only the global flags.`,
					placeholder: "--effort medium",
					aliases: [`${name} flags`],
				}),
				...extra,
			],
		};
	}

	/** (Re)build one model dropdown from the cached model list. */
	private fillModelSelect(sel: HTMLSelectElement, key: ModelKey): void {
		const current = this.plugin.settings[key];
		sel.replaceChildren();
		sel.add(new Option("Default", ""));
		for (const m of this.models) {
			sel.add(new Option(m.display_name, m.id));
		}
		// The configured model must always be selectable, even when the fetch
		// failed or didn't list it (deprecated id, different key scope).
		if (current && !this.models.some(m => m.id === current)) {
			sel.add(new Option(current, current));
		}
		sel.value = current;
	}

	/**
	 * Fetch the model list once per API key and populate the dropdowns on
	 * screen. Failure of any kind (no key, bad key, offline) keeps the dropdowns
	 * usable: they offer "Default" and the configured model.
	 */
	private async loadModels(): Promise<void> {
		const apiKey = resolveAnthropicKey(this.plugin.settings.anthropicApiKey);
		if (apiKey === this.modelsFetchedFor) return;
		this.modelsFetchedFor = apiKey;
		const seq = ++this.modelRefreshSeq;
		const result = apiKey ? await listAnthropicModels(apiKey) : null;
		// A newer fetch started while this one was in flight — let it win.
		if (seq !== this.modelRefreshSeq) return;
		this.models = result ?? [];
		// Let a failed fetch be retried the next time a dropdown renders.
		if (apiKey && !result) this.modelsFetchedFor = null;
		for (const {sel, key} of this.modelSelects) {
			this.fillModelSelect(sel, key);
		}
	}

	private renderImportantOrganizers(setting: Setting): void {
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

		let searchSeq = 0;
		const searchPeople = async (query: string) => {
			const seq = ++searchSeq;
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
				// A newer query was issued while this one was in flight — let it win.
				if (seq !== searchSeq) return;
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
