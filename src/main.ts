import {MarkdownView, Notice, Platform, Plugin, TFile} from "obsidian";
import {execFile} from "child_process";
import {DEFAULT_SETTINGS, WhisperCalSettings, WhisperCalSettingTab} from "./settings";
import {VIEW_TYPE_CALENDAR, COMMAND_OPEN_CALENDAR, COMMAND_LINK_RECORDING, COMMAND_TAG_SPEAKERS, COMMAND_SUMMARIZE, COMMAND_RESEARCH, COMMAND_WORD_REPLACE} from "./constants";
import {CalendarView, type CalendarViewCallbacks} from "./ui/CalendarView";
import {linkRecording} from "./services/LinkRecording";
import {spawnLlmPrompt, validateLlmCli, resolvePromptPath, activeProcesses, stripAnsi} from "./services/LlmInvoker";
import {summarizeJobs, speakerTagJobs, researchJobs, cardStatus, type CardStatusVariant} from "./state";
import {parseSpeakerTagOutput, enrichLineCountsFromBody, hasCachedProposals, buildMappingsFromCache, writeSpeakerProposals, clearSpeakerProposals, type ProposedSpeakerMapping} from "./services/SpeakerTagParser";
import {access} from "fs/promises";
import {SpeakerTagModal} from "./ui/SpeakerTagModal";
import {CachedProposalModal} from "./ui/CachedProposalModal";
import {ResearchModal} from "./ui/ResearchModal";
import {applySpeakerTags} from "./services/SpeakerTagApplier";
import {parseDateTime, setTimeFormat} from "./utils/time";
import {updateFrontmatter} from "./utils/frontmatter";
import {buildMeetingSubtitle} from "./ui/ModalHeader";
import {resolveWikiLink, stripWikiLink} from "./utils/vault";
import type {AuthState, TokenCache} from "./services/AuthTypes";
import type {CalendarAuth} from "./services/CalendarAuth";
import type {CalendarProvider, CalendarProviderType} from "./types";
import type {PeopleSearchProvider} from "./services/PeopleSearchProvider";
import {createCalendarStack, getAuthConfig} from "./services/CalendarProviderFactory";
import {CachedCalendarProvider} from "./services/CalendarCache";
import type {UnlinkedRecordingProvider} from "./services/UnlinkedRecordingProvider";
import {createUnlinkedProvider} from "./services/UnlinkedProviderFactory";
import {applyWordReplacements, showReplacementNotice} from "./services/WordReplacer";
import {appendLlmErrorSection} from "./utils/llmErrorLog";
import {getLinkedTranscriptFile} from "./services/ApiRecording";
import {WordReplacementModal} from "./ui/WordReplacementModal";
import {installBundledPrompts} from "./services/PromptInstaller";
import {PeopleMatchService} from "./services/PeopleMatchService";

/** Derive a short display name from a Claude model ID, e.g. "claude-opus-4-6" → "Opus 4.6" */
function formatModelName(modelId: string): string {
	if (!modelId) return "";
	const match = modelId.match(/^claude-(\w+)-(\d+)-(\d+)/);
	if (match) {
		const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
		return `${family} ${match[2]}.${match[3]}`;
	}
	return modelId;
}

/** Extract invitee names from transcript frontmatter (meeting_invitees, calendar_attendees, or invitees). */
function parseInviteeNames(fm: Record<string, unknown>): string[] {
	const raw = fm["meeting_invitees"] ?? fm["calendar_attendees"] ?? fm["invitees"];
	if (!Array.isArray(raw)) return [];
	const names: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		// Strip wiki-link wrappers: "[[People/Jane Smith]]" → "Jane Smith"
		const stripped = entry.replace(/^\[\[/, "").replace(/\]\]$/, "");
		// Take the last path segment if it's a path
		const name = stripped.includes("/") ? stripped.split("/").pop()! : stripped;
		if (name) names.push(name);
	}
	return names;
}

interface PluginData extends WhisperCalSettings {
	// Legacy single token cache (migrated on load)
	tokenCache?: TokenCache | null;
	// Per-provider token caches
	microsoftTokenCache?: TokenCache | null;
	googleTokenCache?: TokenCache | null;
}

export default class WhisperCalPlugin extends Plugin {
	settings!: WhisperCalSettings;
	auth!: CalendarAuth;
	peopleSearch!: PeopleSearchProvider;
	private upstream!: CalendarProvider;
	private provider!: CalendarProvider;
	private cachedProvider: CachedCalendarProvider | null = null;
	private viewCallbacks!: CalendarViewCallbacks;
	private authStateListeners: Array<(state: AuthState) => void> = [];
	private microsoftTokenCache: TokenCache | null = null;
	private googleTokenCache: TokenCache | null = null;
	private activeProviderType: CalendarProviderType = "microsoft";
	private unlinkedProvider!: UnlinkedRecordingProvider;

	async onload() {
		await this.loadSettings();

		// Defer prompt installation until the vault layout is ready
		this.app.workspace.onLayoutReady(() => {
			void installBundledPrompts(this.app);
		});

		this.activeProviderType = this.settings.calendarProvider;
		const stack = createCalendarStack(
			this.settings.calendarProvider,
			this.settings,
			{
				loadTokenCache: () => this.loadTokenCache(),
				saveTokenCache: (cache) => this.saveTokenCache(cache),
				onStateChange: (state) => this.notifyAuthStateListeners(state),
			},
		);
		this.auth = stack.auth;
		this.upstream = stack.provider;
		this.peopleSearch = stack.peopleSearch;
		this.auth.initialize();

		this.cachedProvider = new CachedCalendarProvider(
			this.app,
			this.upstream,
			this.manifest.dir!,
			this.settings.cacheFutureDays,
			this.settings.cacheRetentionDays,
			this.settings.timezone,
		);
		await this.cachedProvider.loadCache();
		this.provider = this.cachedProvider;

		this.unlinkedProvider = createUnlinkedProvider(this.settings, this.app);

		this.viewCallbacks = {
			getCacheStatus: () => this.cachedProvider?.getLastStatus() ?? null,
			getUserEmail: () => this.upstream.getUserEmail(),
			onTagSpeakers: (transcriptFile: TFile, transcriptFm: Record<string, unknown>, notePath: string) => {
				void this.doTagSpeakers(transcriptFile, transcriptFm, notePath);
			},
			onSummarize: (notePath: string, force?: boolean) => {
				if (force) {
					void this.regenerateSummary(notePath);
				} else {
					this.doSummarize(notePath);
				}
			},
			onResearch: (notePath: string) => {
				this.doResearch(notePath);
			},
			getAuthState: () => this.auth.getState(),
			onSignIn: () => this.auth.startSignIn(),
			onOpenSettings: () => {
				// app.setting is undocumented but widely used by community plugins
				const appWithSetting = this.app as unknown as {setting?: {open(): void; openTabById(id: string): void}};
				appWithSetting.setting?.open();
				appWithSetting.setting?.openTabById(this.manifest.id);
			},
			subscribeAuthState: (listener) => this.onAuthStateChange(listener),
			getUnlinkedProvider: () => this.unlinkedProvider,
		};

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) =>
			new CalendarView(leaf, this.settings, this.provider, this.viewCallbacks)
		);

		// Mirror pipeline_state from transcript files back to their meeting notes
		this.registerEvent(
			this.app.metadataCache.on("changed", (file: TFile) => {
				if (!file.path.startsWith(this.settings.transcriptFolderPath + "/")) return;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fm) return;
				const pipelineState = (fm as Record<string, unknown>)["pipeline_state"];
				if (typeof pipelineState !== "string" || !pipelineState) return;
				// Resolve meeting note from transcript's meeting_note backlink
				const meetingFile = resolveWikiLink(this.app, fm as Record<string, unknown>, "meeting_note", file.path);
				if (!meetingFile) return;
				// Check if meeting note already has this pipeline_state
				const meetingFm = this.app.metadataCache.getFileCache(meetingFile)?.frontmatter;
				if (meetingFm?.["pipeline_state"] === pipelineState) return;
				// Mirror it
				void updateFrontmatter(this.app, meetingFile.path, "pipeline_state", pipelineState);
			}),
		);

		this.addRibbonIcon("calendar", "Open calendar view", () => {
			void this.activateView();
		});

		this.addCommand({
			id: COMMAND_OPEN_CALENDAR,
			name: "Open calendar view",
			callback: () => {
				void this.activateView();
			},
		});

		if (Platform.isMacOS) {
			this.addCommand({
				id: COMMAND_LINK_RECORDING,
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				name: "Link MacWhisper recording",
				checkCallback: (checking) => {
					const file = this.app.workspace.getActiveFile();
					if (!file) return false;
					const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
					if (!fm?.["calendar_event_id"]) return false;
					if (checking) return true;
					void this.handleLinkRecording(file, fm);
					return true;
				},
			});

			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (!(file instanceof TFile)) return;
					const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
					if (!fm?.["calendar_event_id"]) return;
					menu.addItem((item) => {
						item
							// eslint-disable-next-line obsidianmd/ui/sentence-case
							.setTitle("Link MacWhisper recording")
							.setIcon("mic")
							.onClick(() => {
								// Re-read frontmatter at click time to avoid stale values
								const freshFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
								if (!freshFm) return;
								void this.handleLinkRecording(file, freshFm);
							});
					});
				}),
			);
		}

		this.addCommand({
			id: COMMAND_TAG_SPEAKERS,
			name: "Tag speakers in transcript",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				const transcriptFile = this.resolveTagSpeakersContext(file, fm);
				if (!transcriptFile) return false;
				if (checking) return true;
				const transcriptFm = this.app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {};
				// If active file is the meeting note (has calendar_event_id), use its path;
				// otherwise (transcript is active) use the transcript path as fallback.
				const notePath = fm?.["calendar_event_id"] ? file.path : transcriptFile.path;
				void this.doTagSpeakers(transcriptFile, transcriptFm as Record<string, unknown>, notePath);
				return true;
			},
		});

		this.addCommand({
			id: COMMAND_SUMMARIZE,
			name: "Summarize meeting transcript",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fm?.["calendar_event_id"]) return false;
				const pipelineState = fm["pipeline_state"] as string | undefined;
				if (pipelineState !== "tagged") return false;
				if (checking) return true;
				this.doSummarize(file.path);
				return true;
			},
		});

		this.addCommand({
			id: COMMAND_RESEARCH,
			name: "Research meeting",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fm?.["calendar_event_id"]) return false;
				if (checking) return true;
				this.doResearch(file.path);
				return true;
			},
		});

		this.addCommand({
			id: COMMAND_WORD_REPLACE,
			name: "Run word replacements",
			editorCallback: (_editor, ctx) => {
				if (ctx.file) {
					void this.doWordReplacements(ctx.file);
				}
			},
		});

		// Add word-replacement icon to note toolbar on every markdown view
		// (only when a replacement file is configured and exists)
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!leaf) return;
				const view = leaf.view;
				if (!(view instanceof MarkdownView)) return;
				if (!this.settings.replacementFilePath) return;
				if (!this.app.vault.getAbstractFileByPath(this.settings.replacementFilePath)) return;
				if (view.containerEl.querySelector(".whisper-cal-word-replace-action")) return;
				const action = view.addAction("replace-all", "Run word replacements", () => {
					const file = view.file;
					if (file) void this.doWordReplacements(file);
				});
				action.addClass("whisper-cal-word-replace-action");
			}),
		);

		// Show/hide LLM banners when switching between notes
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.updateAllBanners()),
		);

		this.addSettingTab(new WhisperCalSettingTab(this.app, this));
	}

	onunload() {
		this.auth.cancelSignIn();
		void this.cachedProvider?.flush();
		// Kill any running LLM processes and clean up job tracking
		for (const proc of activeProcesses) {
			proc.kill("SIGTERM");
		}
		activeProcesses.clear();
		speakerTagJobs.clear();
		summarizeJobs.clear();
		researchJobs.clear();
	}

	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		// Propagate updated settings to live components (same as saveSettings does)
		this.auth.updateConfig(getAuthConfig(this.activeProviderType, this.settings));
		this.cachedProvider?.updateConfig(
			this.settings.cacheFutureDays,
			this.settings.cacheRetentionDays,
			this.settings.timezone,
		);
		setTimeFormat(this.settings.timeFormat);
		this.unlinkedProvider = createUnlinkedProvider(this.settings, this.app);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) {
				view.updateSettings(this.settings, this.provider);
			}
		}
	}

	/** Get the vault's absolute filesystem path (undocumented but stable on desktop). */
	private getVaultPath(): string {
		const adapter = this.app.vault.adapter as unknown as Record<string, unknown>;
		const basePath = adapter["basePath"];
		if (typeof basePath !== "string") {
			throw new Error("Cannot determine vault path — unsupported platform");
		}
		return basePath;
	}

	async loadSettings() {
		const data = await this.loadData() as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

		// Migrate legacy single tokenCache → microsoftTokenCache
		if (data?.tokenCache && !data.microsoftTokenCache) {
			this.microsoftTokenCache = data.tokenCache;
		} else {
			this.microsoftTokenCache = data?.microsoftTokenCache ?? null;
		}
		this.googleTokenCache = data?.googleTokenCache ?? null;

		// Migrate old importantOrganizerEmails (string[]) to importantOrganizers ({name, email}[])
		const legacy = data as Record<string, unknown> | null;
		if (legacy?.importantOrganizerEmails && Array.isArray(legacy.importantOrganizerEmails)) {
			const oldEmails = legacy.importantOrganizerEmails as string[];
			if (oldEmails.length > 0 && (!this.settings.importantOrganizers || this.settings.importantOrganizers.length === 0)) {
				this.settings.importantOrganizers = oldEmails.map(e => ({name: e, email: e}));
			}
		}
		// Migrate legacy single llmModel → per-prompt model settings
		if (legacy?.llmModel && typeof legacy.llmModel === "string") {
			const old = legacy.llmModel;
			if (!this.settings.speakerTagModel) this.settings.speakerTagModel = old;
			if (!this.settings.summarizerModel) this.settings.summarizerModel = old;
			if (!this.settings.researchModel) this.settings.researchModel = old;
		}
		// Backfill llmExtraFlags for installs that saved before the default existed
		if (!this.settings.llmExtraFlags) {
			this.settings.llmExtraFlags = DEFAULT_SETTINGS.llmExtraFlags;
		}
		// MacWhisper is macOS-only; coerce to Recording API on other platforms
		if (!Platform.isMacOS && this.settings.recordingSource === "macwhisper") {
			this.settings.recordingSource = "api";
		}
		// Auto-populate microphoneUser from macOS account on first install
		if (Platform.isMacOS && !this.settings.microphoneUser) {
			try {
				const fullName = await new Promise<string>((resolve) => {
					execFile("id", ["-F"], {encoding: "utf-8", timeout: 3000}, (err, stdout) => {
						resolve(err ? "" : stdout.trim());
					});
				});
				if (fullName) {
					this.settings.microphoneUser = fullName;
					await this.persistData();
				}
			} catch {
				// Leave empty — user can fill in manually
			}
		}
		setTimeFormat(this.settings.timeFormat);
	}

	async saveSettings() {
		await this.persistData();

		// If provider type changed, rebuild the entire stack
		if (this.settings.calendarProvider !== this.activeProviderType) {
			this.auth.cancelSignIn();
			await this.cachedProvider?.clear();

			this.activeProviderType = this.settings.calendarProvider;
			const stack = createCalendarStack(
				this.settings.calendarProvider,
				this.settings,
				{
					loadTokenCache: () => this.loadTokenCache(),
					saveTokenCache: (cache) => this.saveTokenCache(cache),
					onStateChange: (state) => this.notifyAuthStateListeners(state),
				},
			);
			this.auth = stack.auth;
			this.upstream = stack.provider;
			this.peopleSearch = stack.peopleSearch;
			this.auth.initialize();

			this.cachedProvider = new CachedCalendarProvider(
				this.app,
				this.upstream,
				this.manifest.dir!,
				this.settings.cacheFutureDays,
				this.settings.cacheRetentionDays,
				this.settings.timezone,
			);
			await this.cachedProvider.loadCache();
			this.provider = this.cachedProvider;
		}

		// Update auth config (e.g. client ID/secret changed)
		this.auth.updateConfig(getAuthConfig(this.activeProviderType, this.settings));
		// Update cache config
		this.cachedProvider?.updateConfig(
			this.settings.cacheFutureDays,
			this.settings.cacheRetentionDays,
			this.settings.timezone,
		);
		setTimeFormat(this.settings.timeFormat);
		// Recreate unlinked provider (recordingSource or transcriptFolderPath may have changed)
		this.unlinkedProvider = createUnlinkedProvider(this.settings, this.app);
		// Update existing views with new settings
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) {
				view.updateSettings(this.settings, this.provider);
			}
		}
	}

	onAuthStateChange(listener: (state: AuthState) => void): () => void {
		this.authStateListeners.push(listener);
		return () => {
			this.authStateListeners = this.authStateListeners.filter(l => l !== listener);
		};
	}

	private notifyAuthStateListeners(state: AuthState): void {
		for (const listener of this.authStateListeners) {
			listener(state);
		}
	}

	private loadTokenCache(): TokenCache | null {
		return this.activeProviderType === "google"
			? this.googleTokenCache
			: this.microsoftTokenCache;
	}

	private async saveTokenCache(cache: TokenCache | null): Promise<void> {
		if (this.activeProviderType === "google") {
			this.googleTokenCache = cache;
		} else {
			this.microsoftTokenCache = cache;
		}
		await this.persistData();
	}

	private async persistData(): Promise<void> {
		await this.saveData({
			...this.settings,
			microsoftTokenCache: this.microsoftTokenCache,
			googleTokenCache: this.googleTokenCache,
		});
	}

	private resolveTagSpeakersContext(
		file: TFile,
		fm: Record<string, unknown> | undefined,
	): TFile | null {
		if (!fm) return null;

		// Context B: transcript note (tags contains "transcript")
		const tags = fm["tags"];
		const hasTranscriptTag = Array.isArray(tags)
			? tags.includes("transcript")
			: tags === "transcript";
		if (hasTranscriptTag && fm["macwhisper_session_id"]) {
			return file;
		}

		// Context A: meeting note with a linked transcript
		if (fm["calendar_event_id"] && fm["macwhisper_session_id"] && fm["transcript"]) {
			return resolveWikiLink(this.app, fm, "transcript", file.path);
		}

		return null;
	}

	// Queue for serializing speaker tag modal presentations
	private speakerTagModalQueue: Promise<void> = Promise.resolve();

	/** Count of currently running LLM processes (speaker tagging + summarization). */
	private activeLlmCount = 0;

	private async doTagSpeakers(
		transcriptFile: TFile,
		transcriptFm: Record<string, unknown>,
		notePath: string,
	): Promise<void> {
		const transcriptPath = transcriptFile.path;
		const state = transcriptFm["pipeline_state"] as string | undefined;
		if (state && state !== "titled") {
			new Notice("Speakers already tagged for this transcript");
			// Heal: ensure the meeting note also reflects at least "tagged"
			void updateFrontmatter(this.app, notePath, "pipeline_state", "tagged");
			return;
		}

		// Check for cached LLM proposals from a previous run (e.g. modal was dismissed)
		if (hasCachedProposals(this.app, transcriptPath)) {
			const choice = await new CachedProposalModal(this.app).prompt();
			if (choice === "view") {
				const mappings = buildMappingsFromCache(this.app, transcriptPath);
				void this.presentSpeakerTagModal(mappings, transcriptFile, transcriptPath, notePath);
				return;
			}
			if (choice === "rerun") {
				await clearSpeakerProposals(this.app, transcriptPath);
				// Fall through to normal LLM path below
			}
			if (!choice) return; // Cancelled
		}

		if (!this.settings.speakerTaggingPromptPath) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("Speaker tagging prompt not configured — set it in WhisperCal settings");
			return;
		}

		// Build People Roster and Calendar Attendees for the LLM.
		// Invitees are always in the parent meeting note frontmatter.
		const noteFile = this.app.vault.getAbstractFileByPath(notePath.endsWith(".md") ? notePath : notePath + ".md");
		const noteFm = noteFile instanceof TFile
			? (this.app.metadataCache.getFileCache(noteFile)?.frontmatter as Record<string, unknown> | undefined) ?? {}
			: {};
		const inviteeNames = parseInviteeNames(noteFm);
		let calendarAttendees: string | undefined;
		let peopleRoster: string | undefined;
		if (inviteeNames.length > 0) {
			calendarAttendees = inviteeNames.join(", ");
		}
		if (this.settings.peopleFolderPath) {
			const peopleSvc = new PeopleMatchService(this.app, this.settings.peopleFolderPath);
			const roster = peopleSvc.buildRoster(
				this.settings.microphoneUser,
				inviteeNames,
				this.settings.rosterMaxEnriched,
			);
			if (roster) peopleRoster = roster;
		}

		this.runLlmJob({
			jobSet: speakerTagJobs,
			filePath: transcriptPath,
			label: "Tagging speakers",
			promptPath: this.settings.speakerTaggingPromptPath,
			cardIcon: "users-round",
			cardModel: this.settings.speakerTagModel || undefined,
			cardNotePath: notePath,
			onRegister: () => this.updateBanners(transcriptPath),
			onCleanup: () => this.updateBanners(transcriptPath),
			spawnOpts: (vaultPath) => ({
				targetPath: transcriptPath,
				targetLabel: "Transcript",
				vaultPath,
				promptPath: this.settings.speakerTaggingPromptPath,
				microphoneUser: this.settings.microphoneUser,
				llmCli: this.settings.llmCli,
				llmExtraFlags: this.settings.llmExtraFlags,
				llmModel: this.settings.speakerTagModel || undefined,
				transcriptFolderPath: this.settings.transcriptFolderPath || undefined,
				peopleFolderPath: this.settings.peopleFolderPath || undefined,
				calendarAttendees,
				peopleRoster,
				outputFormat: 'Output format: Return ONLY a fenced JSON code block with this schema: {"speakers":[{"index":0,"original_name":"...","proposed_name":"...or null","confidence":"CERTAIN|HIGH|LOW|null","evidence":"..."}]}. Do not include any other text outside the JSON block.',
				timeoutMs: this.settings.llmTimeoutMinutes > 0 ? this.settings.llmTimeoutMinutes * 60000 : 0,
				debugMode: this.settings.llmDebugMode,
			}),
			onSuccess: (result) => void this.handleSpeakerTagSuccess(result.stdout, transcriptFile, transcriptPath, notePath),
		});
	}

	private async handleSpeakerTagSuccess(stdout: string, transcriptFile: TFile, transcriptPath: string, notePath: string): Promise<void> {
		// Clear the "Tagging speakers…" progress status now that the LLM is done.
		// Success/error paths below will set their own status as needed.
		const clearProgressStatus = () => this.clearProgressStatus(notePath);

		// Verify the transcript file still exists after the LLM run
		if (!this.app.vault.getAbstractFileByPath(transcriptPath)) {
			new Notice("Transcript was deleted while speaker tagging was running");
			clearProgressStatus();
			return;
		}

		const {mappings, warning} = parseSpeakerTagOutput(stdout, this.app, transcriptPath);
		if (warning) {
			console.warn("[WhisperCal]", warning);
		}
		if (mappings.length === 0) {
			new Notice(warning || "LLM returned no speaker mappings — check the prompt and transcript");
			clearProgressStatus();
			return;
		}
		if (warning) {
			new Notice(warning);
		}

		// Cache proposals in transcript frontmatter so they survive modal dismissal
		await writeSpeakerProposals(this.app, transcriptPath, mappings);

		await this.presentSpeakerTagModal(mappings, transcriptFile, transcriptPath, notePath);
	}

	/**
	 * Show the SpeakerTagModal for a set of proposed mappings (from LLM or cache).
	 * Handles line-count enrichment, modal queuing, apply/dismiss, word replacements,
	 * and auto-summarize.
	 */
	private async presentSpeakerTagModal(
		mappings: ProposedSpeakerMapping[],
		transcriptFile: TFile,
		transcriptPath: string,
		notePath: string,
	): Promise<void> {
		const clearProgressStatus = () => this.clearProgressStatus(notePath);

		// Always read transcript content — needed for line-count enrichment and excerpt panel
		const transcriptContent = await this.app.vault.cachedRead(transcriptFile);

		// Enrich line counts from body text when frontmatter lacks them (e.g. Tome transcripts)
		if (mappings.some(m => m.lineCount === 0)) {
			enrichLineCountsFromBody(mappings, transcriptContent);
		}

		// Queue the modal so parallel completions are presented one at a time.
		// Wrap in try/catch so one failure doesn't break the chain for subsequent modals.
		this.speakerTagModalQueue = this.speakerTagModalQueue.then(async () => {
			try {
				const meetingFile = this.app.vault.getAbstractFileByPath(notePath);
				const meetingFm = meetingFile instanceof TFile
					? (this.app.metadataCache.getFileCache(meetingFile)?.frontmatter ?? {})
					: {};
				const title = (meetingFm["meeting_subject"] as string) || transcriptFile.basename;
				const subtitle = buildMeetingSubtitle(meetingFm);
				const decisions = await new SpeakerTagModal(this.app, mappings, title, subtitle, this.settings.peopleFolderPath, this.settings.microphoneUser, transcriptContent).prompt();
				if (!decisions) {
					clearProgressStatus();
					return;
				}

				const hasTagged = decisions.some(d => d.confirmedName);
				if (!hasTagged) {
					new Notice("No speakers tagged — no changes made");
					clearProgressStatus();
					return;
				}

				await applySpeakerTags(this.app, transcriptPath, decisions);

				// Apply word replacements to transcript now that speaker tags are in place
				if (this.settings.replacementFilePath) {
					const result = await applyWordReplacements(this.app, transcriptPath, this.settings.replacementFilePath);
					if (result.totalCount > 0) {
						console.debug(`[WhisperCal] Applied ${result.totalCount} word replacement(s) to transcript`);
						showReplacementNotice(result);
					}
				}

				// Directly update meeting note pipeline_state rather than
				// waiting for the async metadataCache mirror event.
				await updateFrontmatter(this.app, notePath, "pipeline_state", "tagged");
				this.setCardStatus(notePath, "Speakers tagged", "check", 4000, "done");

				// Auto-summarize if enabled
				if (this.settings.autoSummarizeAfterTagging && this.settings.summarizerPromptPath) {
					this.doSummarize(notePath, true);
				}

				this.refreshCalendarCards(transcriptPath);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error("[WhisperCal] Speaker tag modal error:", e);
				new Notice(`Failed to apply speaker tags: ${msg}`);
				clearProgressStatus();
			}
		});
	}

	/**
	 * Reset pipeline_state to "tagged" on the meeting note and its linked
	 * transcript so the summarizer prompt's literal `tagged` → `summarized`
	 * find-replace succeeds on re-runs, then re-invoke summarization.
	 */
	private async regenerateSummary(notePath: string): Promise<void> {
		const noteFile = this.app.vault.getAbstractFileByPath(notePath);
		if (!(noteFile instanceof TFile)) {
			new Notice("Meeting note not found");
			return;
		}
		if (summarizeJobs.has(notePath)) {
			new Notice("Summarization already in progress");
			return;
		}
		await updateFrontmatter(this.app, notePath, "pipeline_state", "tagged");
		const transcriptFile = getLinkedTranscriptFile(this.app, notePath);
		if (transcriptFile) {
			await updateFrontmatter(this.app, transcriptFile.path, "pipeline_state", "tagged");
		}
		await this.doSummarize(notePath, true);
	}

	private async doSummarize(notePath: string, skipPipelineCheck = false): Promise<void> {
		const noteFile = this.app.vault.getAbstractFileByPath(notePath);
		if (!(noteFile instanceof TFile)) {
			new Notice("Meeting note not found");
			return;
		}
		if (!skipPipelineCheck) {
			const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
			if (!fm) {
				new Notice("Meeting note has no frontmatter");
				return;
			}
			const pipelineState = fm["pipeline_state"] as string | undefined;
			if (pipelineState === "summarized") {
				new Notice("This meeting has already been summarized");
				return;
			}
			if (pipelineState !== "tagged") {
				new Notice("Speakers must be tagged before summarizing");
				return;
			}
		}
		if (!this.settings.summarizerPromptPath) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("Summarizer prompt not configured — set it in WhisperCal settings");
			return;
		}

		// Apply word replacements to transcript before LLM processing
		if (this.settings.replacementFilePath) {
			const transcriptFile = getLinkedTranscriptFile(this.app, notePath);
			if (transcriptFile) {
				const result = await applyWordReplacements(this.app, transcriptFile.path, this.settings.replacementFilePath);
				if (result.totalCount > 0) {
					console.debug(`[WhisperCal] Applied ${result.totalCount} word replacement(s) before summarization`);
				}
			}
		}

		this.runLlmJob({
			jobSet: summarizeJobs,
			filePath: notePath,
			label: "Summarizing",
			promptPath: this.settings.summarizerPromptPath,
			cardIcon: "sparkles",
			cardModel: this.settings.summarizerModel || undefined,
			onRegister: () => this.updateBanners(notePath),
			onCleanup: () => this.updateBanners(notePath),
			spawnOpts: (vaultPath) => ({
				targetPath: notePath,
				targetLabel: "Meeting note",
				vaultPath,
				promptPath: this.settings.summarizerPromptPath,
				llmCli: this.settings.llmCli,
				llmExtraFlags: this.settings.llmExtraFlags,
				llmModel: this.settings.summarizerModel || undefined,
				timeoutMs: this.settings.llmTimeoutMinutes > 0 ? this.settings.llmTimeoutMinutes * 60000 : 0,
				debugMode: this.settings.llmDebugMode,
			}),
			onSuccess: ({exitCode, stderr}) => {
				if (exitCode === 0) {
					if (!this.app.vault.getAbstractFileByPath(notePath)) {
						new Notice("Meeting note was deleted while summarization was running");
					} else {
						this.setCardStatus(notePath, "Summarization complete", "check", 4000, "done");
					}
				} else {
					const excerpt = stripAnsi(stderr.trim()).slice(0, 200);
					new Notice(`Summarization failed (exit ${exitCode})${excerpt ? ": " + excerpt : ""}`);
				}
			},
		});
	}

	private async doWordReplacements(file: TFile): Promise<void> {
		if (!this.settings.replacementFilePath) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("Word replacement file not configured — set it in WhisperCal settings");
			return;
		}
		if (!this.settings.skipWordReplacementConfirm) {
			const result = await new WordReplacementModal(
				this.app,
				this.settings.replacementFilePath,
				file.basename,
			).prompt();
			if (!result.confirmed) return;
			if (result.doNotShowAgain) {
				this.settings.skipWordReplacementConfirm = true;
				await this.saveSettings();
			}
		}

		try {
			const result = await applyWordReplacements(this.app, file.path, this.settings.replacementFilePath);
			showReplacementNotice(result);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Word replacement failed: ${msg}`);
		}
	}

	private doResearch(notePath: string): void {
		const noteFile = this.app.vault.getAbstractFileByPath(notePath);
		if (!(noteFile instanceof TFile)) {
			new Notice("Meeting note not found");
			return;
		}
		const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {};
		const title = (fm["meeting_subject"] as string) || noteFile.basename;
		const subtitle = buildMeetingSubtitle(fm);

		void (async () => {
			const result = await new ResearchModal(this.app, title, subtitle).prompt();
			if (!result) return;

			// Normal mode: require notes; bypass mode: require prompt text (enforced by modal)
			if (!result.bypassPrompt && result.paths.length === 0) return;
			if (!result.bypassPrompt && !this.settings.researchPromptPath) {
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				new Notice("Research prompt not configured \u2014 set it in WhisperCal settings");
				return;
			}

			// Store selected research notes in frontmatter
			if (result.paths.length > 0) {
				const wikilinks = result.paths.map(p => `[[${p.replace(/\.md$/, "")}]]`).join(", ");
				await updateFrontmatter(this.app, notePath, "research_notes", wikilinks);
			}

			this.runLlmJob({
				jobSet: researchJobs,
				filePath: notePath,
				label: "Researching",
				promptPath: result.bypassPrompt ? undefined : this.settings.researchPromptPath,
				cardIcon: "book-open",
				cardModel: this.settings.researchModel || undefined,
				onRegister: () => this.updateBanners(notePath),
				onCleanup: () => this.updateBanners(notePath),
				spawnOpts: (vaultPath) => ({
					targetPath: notePath,
					targetLabel: "Meeting note",
					vaultPath,
					...(result.bypassPrompt
						? {inlinePrompt: `Read the meeting note and follow these instructions. Write your results back into the meeting note under a ## Research section (replace it if one already exists). Instructions: ${result.instructions}`}
						: {promptPath: this.settings.researchPromptPath}),
					llmCli: this.settings.llmCli,
					llmExtraFlags: this.settings.llmExtraFlags,
					llmModel: this.settings.researchModel || undefined,
					researchNotePaths: result.paths.length > 0 ? result.paths : undefined,
					additionalInstructions: result.bypassPrompt ? undefined : (result.instructions || undefined),
					peopleFolderPath: this.settings.peopleFolderPath || undefined,
					timeoutMs: this.settings.llmTimeoutMinutes > 0 ? this.settings.llmTimeoutMinutes * 60000 : 0,
					debugMode: this.settings.llmDebugMode,
				}),
				onSuccess: ({exitCode, stderr}) => {
					if (exitCode === 0) {
						if (!this.app.vault.getAbstractFileByPath(notePath)) {
							new Notice("Meeting note was deleted while research was running");
						} else {
							this.setCardStatus(notePath, "Research complete", "check", 4000, "done");
						}
					} else {
						const excerpt = stripAnsi(stderr.trim()).slice(0, 200);
						new Notice(`Research failed (exit ${exitCode})${excerpt ? ": " + excerpt : ""}`);
					}
				},
			});
		})();
	}

	/**
	 * Shared LLM job runner. Handles concurrency gating, CLI/prompt validation,
	 * process spawning, debug mode, error handling, and cleanup.
	 */
	private runLlmJob(opts: {
		jobSet: Set<string>;
		filePath: string;
		label: string;
		promptPath?: string;
		spawnOpts: (vaultPath: string) => Parameters<typeof spawnLlmPrompt>[0];
		onSuccess: (result: {exitCode: number; stdout: string; stderr: string}) => void;
		onRegister?: () => void;
		onCleanup?: () => void;
		/** Icon for card status (e.g. "sparkles", "users-round", "book-open") */
		cardIcon?: string;
		/** Model ID for card status suffix (e.g. "claude-opus-4-6") */
		cardModel?: string;
		/** Note path for card status (defaults to filePath) */
		cardNotePath?: string;
	}): void {
		const {jobSet, filePath, label, promptPath} = opts;

		if (!this.settings.llmEnabled) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("LLM features are disabled — enable them in WhisperCal settings");
			return;
		}
		if (jobSet.has(filePath)) {
			new Notice(`${label} already in progress`);
			return;
		}
		if (this.activeLlmCount >= this.settings.llmMaxConcurrent) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("LLM concurrency limit reached — try again when a running job finishes");
			return;
		}

		// Register job synchronously before any async work
		jobSet.add(filePath);
		this.activeLlmCount++;

		// Set in-progress card status. The same path is used for routing
		// LLM error logs — for speaker tagging that's the parent meeting note,
		// for summarize/research it's the meeting note (== filePath).
		const statusNotePath = opts.cardNotePath ?? filePath;
		const errorNotePath = statusNotePath;
		if (opts.cardIcon) {
			const modelSuffix = opts.cardModel ? ` (${formatModelName(opts.cardModel)})` : "";
			this.setCardStatus(statusNotePath, `${label}${modelSuffix}\u2026`, opts.cardIcon, 0, "progress");
		} else {
			this.refreshCalendarCards(filePath);
		}
		opts.onRegister?.();

		void (async () => {
			try {
				const vaultPath = this.getVaultPath();

				if (!await validateLlmCli(this.settings.llmCli)) {
					new Notice(`LLM CLI '${this.settings.llmCli}' not found — check WhisperCal settings`);
					return;
				}

				if (promptPath) {
					const resolvedPrompt = resolvePromptPath(promptPath, vaultPath);
					try {
						await access(resolvedPrompt);
					} catch {
						new Notice(`${label} prompt file not found: ${resolvedPrompt}`);
						return;
					}
				}

				const result = await spawnLlmPrompt(opts.spawnOpts(vaultPath));

				if (this.settings.llmDebugMode) {
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					new Notice("LLM debug session opened in Terminal");
					this.clearProgressStatus(statusNotePath);
					return;
				}

				if (result.exitCode !== 0) {
					await appendLlmErrorSection(this.app, errorNotePath, {
						label,
						exitCode: result.exitCode,
						stderr: result.stderr,
						stdout: result.stdout,
						cli: this.settings.llmCli,
						model: opts.cardModel,
					});
				}

				opts.onSuccess(result);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`${label} encountered an unexpected error: ${msg}`);
				console.error(`[WhisperCal] ${label} error:`, e);
				await appendLlmErrorSection(this.app, errorNotePath, {
					label: `${label} (unexpected error)`,
					exitCode: -1,
					stderr: e instanceof Error ? (e.stack || e.message) : String(e),
					cli: this.settings.llmCli,
					model: opts.cardModel,
				});
			} finally {
				jobSet.delete(filePath);
				this.activeLlmCount--;
				this.clearProgressStatus(statusNotePath);
				this.refreshCalendarCards(filePath);
				opts.onCleanup?.();
			}
		})();
	}

	private setCardStatus(notePath: string, message: string, icon?: string, durationMs = 4000, variant?: CardStatusVariant): void {
		cardStatus.set(notePath, {message, icon, variant});
		this.refreshCalendarCards(notePath);
		if (durationMs > 0) {
			setTimeout(() => {
				if (cardStatus.get(notePath)?.message === message) {
					cardStatus.delete(notePath);
					this.refreshCalendarCards(notePath);
				}
			}, durationMs);
		}
	}

	private clearProgressStatus(notePath: string): void {
		const cs = cardStatus.get(notePath);
		if (cs?.variant === "progress") {
			cardStatus.delete(notePath);
			this.refreshCalendarCards(notePath);
		}
	}

	private refreshCalendarCards(filePath?: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) {
				if (filePath) {
					view.rerenderCard(filePath);
				} else {
					view.rerenderCards();
				}
			}
		}
	}

	private static readonly BANNER_CLS = "whisper-cal-llm-banner";

	private static readonly BANNER_OPS: {jobSet: Set<string>; op: string; label: string}[] = [
		{jobSet: summarizeJobs, op: "summarize", label: "Summarizing\u2026"},
		{jobSet: speakerTagJobs, op: "speakers", label: "Tagging speakers\u2026"},
		{jobSet: researchJobs, op: "research", label: "Researching\u2026"},
	];

	/** Add or remove LLM banners for all leaves showing the given file. */
	private updateBanners(filePath: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === filePath) {
				for (const {jobSet, op, label} of WhisperCalPlugin.BANNER_OPS) {
					if (jobSet.has(filePath)) {
						this.ensureBanner(view, op, label);
					} else {
						this.removeBanner(view, op);
					}
				}
			}
		}
	}

	/** Refresh banners for all open markdown leaves (e.g. on tab switch). */
	private updateAllBanners(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file) {
				for (const {jobSet, op, label} of WhisperCalPlugin.BANNER_OPS) {
					if (jobSet.has(view.file.path)) {
						this.ensureBanner(view, op, label);
					} else {
						this.removeBanner(view, op);
					}
				}
			}
		}
	}

	private ensureBanner(view: MarkdownView, op: string, label: string): void {
		const container = view.contentEl;
		if (container.querySelector(`.${WhisperCalPlugin.BANNER_CLS}[data-op="${op}"]`)) return;
		const banner = container.createDiv({cls: WhisperCalPlugin.BANNER_CLS});
		banner.dataset["op"] = op;
		banner.createSpan({cls: "whisper-cal-card-status-dot"});
		banner.createSpan({text: label});
		container.prepend(banner);
	}

	private removeBanner(view: MarkdownView, op: string): void {
		view.contentEl
			.querySelectorAll(`.${WhisperCalPlugin.BANNER_CLS}[data-op="${op}"]`)
			.forEach(el => el.remove());
	}

	private async handleLinkRecording(
		file: TFile,
		fm: Record<string, unknown>,
	): Promise<void> {
		if (fm["macwhisper_session_id"]) {
			new Notice("Recording already linked to this note");
			return;
		}

		// Use the scheduled meeting time (meeting_date + meeting_start) so
		// recording matching works even when the note is created days later.
		// Fall back to note_created only for unscheduled meetings where
		// the note is typically created at recording time.
		let meetingStart: Date | null = null;

		const rawDate = fm["meeting_date"];
		const timeStr = fm["meeting_start"] as string | undefined;
		if (rawDate && timeStr) {
			// meeting_date may be a YAML Date object in notes created before the
			// template was fixed to quote this value. Keep both branches for compat.
			const dateStr = rawDate instanceof Date
				? rawDate.toISOString().slice(0, 10)
				: rawDate as string;
			meetingStart = parseDateTime(dateStr, timeStr);
		}
		if (!meetingStart || isNaN(meetingStart.getTime())) {
			// Fall back to file creation time (covers unscheduled/ad-hoc notes)
			meetingStart = new Date(file.stat.ctime);
		}
		if (!meetingStart || isNaN(meetingStart.getTime())) {
			new Notice("Missing meeting date/time in frontmatter");
			return;
		}

		const subject = (fm["meeting_subject"] as string) || file.basename;
		const isUnscheduled = fm["calendar_event_id"] === "unscheduled";

		// Extract attendee names from frontmatter (stored as wiki links or plain strings)
		const rawAttendees = Array.isArray(fm["meeting_invitees"]) ? fm["meeting_invitees"] as string[] : [];
		const attendees = rawAttendees.map(s => {
			const name = stripWikiLink(String(s).replace(/^"/, "").replace(/"$/, ""));
			return {name, email: ""};
		});

		const isRecurring = fm["is_recurring"] === true;

		await linkRecording({
			app: this.app,
			meetingStart,
			notePath: file.path,
			subject,
			timezone: this.settings.timezone,
			transcriptFolderPath: this.settings.transcriptFolderPath,
			attendees,
			isRecurring,
			windowMinutes: isUnscheduled ? 720 : undefined,
			onStatus: (msg, icon, autoClearMs, variant) => {
				if (msg) {
					this.setCardStatus(file.path, msg, icon, autoClearMs ?? 0, variant);
				} else {
					cardStatus.delete(file.path);
					this.refreshCalendarCards(file.path);
				}
			},
		});
	}

	private async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]!);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: VIEW_TYPE_CALENDAR, active: true});
			await this.app.workspace.revealLeaf(leaf);
		}
	}
}
