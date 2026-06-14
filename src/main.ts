import {FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, TFile} from "obsidian";
import {execFile} from "child_process";
import {DEFAULT_SETTINGS, WhisperCalSettings, WhisperCalSettingTab} from "./settings";
import {VIEW_TYPE_CALENDAR, COMMAND_OPEN_CALENDAR, COMMAND_LINK_RECORDING, COMMAND_TAG_SPEAKERS, COMMAND_SUMMARIZE, COMMAND_RESEARCH, COMMAND_WORD_REPLACE, FM} from "./constants";
import {CalendarView, type CalendarViewCallbacks} from "./ui/CalendarView";
import {linkRecording} from "./services/LinkRecording";
import {spawnLlmPrompt, validateLlmCli, resolvePromptPath, activeProcesses, stripAnsi} from "./services/LlmInvoker";
import {JobTracker, type JobKind} from "./services/JobTracker";
import {CardUiState, type CardStatusVariant} from "./services/CardUiState";
import {parseSpeakerTagOutput, enrichLineCountsFromBody, hasCachedProposals, buildMappingsFromCache, buildMappingsFromBody, writeSpeakerProposals, clearSpeakerProposals, type ProposedSpeakerMapping} from "./services/SpeakerTagParser";
import {access} from "fs/promises";
import {SpeakerTagModal} from "./ui/SpeakerTagModal";
import {CachedProposalModal} from "./ui/CachedProposalModal";
import {ResearchModal} from "./ui/ResearchModal";
import {applySpeakerTags} from "./services/SpeakerTagApplier";
import {enrollVoiceprints, healVoiceprints} from "./services/VoiceprintEnroller";
import {matchVoiceprints, type VoiceprintMatch} from "./services/VoiceprintMatcher";
import {parseDateTime, setTimeFormat} from "./utils/time";
import {updateFrontmatter, readFmString} from "./utils/frontmatter";
import {buildMeetingSubtitle} from "./ui/ModalHeader";
import {resolveWikiLink, stripWikiLink} from "./utils/vault";
import {transcriptBody, findSpeakerLabels} from "./utils/transcript";
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
import {AutoSpeakerTagger} from "./services/AutoSpeakerTagger";

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
	const raw = fm[FM.MEETING_INVITEES] ?? fm[FM.CALENDAR_ATTENDEES] ?? fm[FM.INVITEES];
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

/**
 * Count whitespace-delimited words in a transcript's body. Paired with the distinct-label
 * count to detect catastrophic deletion by an in-place post-processing edit.
 */
function bodyWordCount(content: string): number {
	return transcriptBody(content).match(/\S+/g)?.length ?? 0;
}

/**
 * Count the distinct speaker labels (`**Label**`) in a transcript's body. Legitimate
 * echo/catch-all cleanup drops duplicate *words* but keeps every real diarized *speaker*; a
 * catastrophic deletion drops whole speakers. Comparing the distinct-label set before/after
 * the edit tells the two apart (see the tripwire in handleSpeakerTagSuccess).
 */
function distinctSpeakerLabels(content: string): number {
	return new Set(findSpeakerLabels(transcriptBody(content)).map(l => l.name)).size;
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
	readonly jobs = new JobTracker();
	readonly cardUi = new CardUiState();
	private upstream!: CalendarProvider;
	private provider!: CalendarProvider;
	private cachedProvider: CachedCalendarProvider | null = null;
	private viewCallbacks!: CalendarViewCallbacks;
	private authStateListeners: Array<(state: AuthState) => void> = [];
	private microsoftTokenCache: TokenCache | null = null;
	private googleTokenCache: TokenCache | null = null;
	private activeProviderType: CalendarProviderType = "microsoft";
	private unlinkedProvider!: UnlinkedRecordingProvider;
	private autoTagger!: AutoSpeakerTagger;

	async onload() {
		await this.loadSettings();

		// Background auto-tagging of newly linked transcripts (automatic mode).
		// Constructed before onLayoutReady so the callback can't race a layout
		// that is already ready.
		this.autoTagger = new AutoSpeakerTagger({
			app: this.app,
			getSettings: () => this.settings,
			jobs: this.jobs,
			canStartLlm: () => this.activeLlmCount < this.settings.llmMaxConcurrent,
			runAutoTag: (file, fm, notePath) => {
				void this.doTagSpeakers(file, fm, notePath, undefined, {auto: true});
			},
			registerEvent: (ref) => this.registerEvent(ref),
		});

		// Defer prompt installation until the vault layout is ready
		this.app.workspace.onLayoutReady(() => {
			void installBundledPrompts(this.app);
			this.autoTagger.start();
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
			jobs: this.jobs,
			cardUi: this.cardUi,
			onTagSpeakers: (transcriptFile: TFile, transcriptFm: Record<string, unknown>, notePath: string, customInstructions?: string) => {
				void this.doTagSpeakers(transcriptFile, transcriptFm, notePath, customInstructions);
			},
			onReviewSpeakerCandidates: (notePath: string) => {
				this.reviewSpeakerCandidates(notePath);
			},
			onSummarize: (notePath: string, force?: boolean, customInstructions?: string) => {
				if (force) {
					void this.regenerateSummary(notePath, customInstructions);
				} else {
					void this.doSummarize(notePath, false, customInstructions);
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
				const pipelineState = readFmString(fm, FM.PIPELINE_STATE);
				if (!pipelineState) return;
				// Resolve meeting note from transcript's meeting_note backlink
				const meetingFile = resolveWikiLink(this.app, fm as Record<string, unknown>, FM.MEETING_NOTE, file.path);
				if (!meetingFile) return;
				// Check if meeting note already has this pipeline_state
				const meetingFm = this.app.metadataCache.getFileCache(meetingFile)?.frontmatter;
				if (readFmString(meetingFm, FM.PIPELINE_STATE) === pipelineState) return;
				// Mirror it
				void updateFrontmatter(this.app, meetingFile.path, FM.PIPELINE_STATE, pipelineState);
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
					if (!fm?.[FM.CALENDAR_EVENT_ID]) return false;
					if (checking) return true;
					void this.handleLinkRecording(file, fm);
					return true;
				},
			});

			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (!(file instanceof TFile)) return;
					const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
					if (!fm?.[FM.CALENDAR_EVENT_ID]) return;
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
				const notePath = fm?.[FM.CALENDAR_EVENT_ID] ? file.path : transcriptFile.path;
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
				if (!fm?.[FM.CALENDAR_EVENT_ID]) return false;
				const pipelineState = readFmString(fm, FM.PIPELINE_STATE);
				if (pipelineState !== "tagged") return false;
				if (checking) return true;
				void this.doSummarize(file.path);
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
				if (!fm?.[FM.CALENDAR_EVENT_ID]) return false;
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

	onunload(): void {
		// Stop the auto-tag queue first so parked sleeps resolve and no new
		// LLM jobs start during teardown.
		this.autoTagger.stop();
		this.auth.cancelSignIn();
		// Stop UI timers and clear job/card state up front so handlers that fire
		// during teardown don't see stale entries.
		this.cardUi.clear();
		this.jobs.clear();
		// Kick the cache flush as fire-and-forget — Obsidian's onunload is sync,
		// but the SQLite-backed flush is async; missing this leaves a partial write.
		void this.cachedProvider?.flush();
		// Kill any running LLM processes; force-kill stragglers after a grace period.
		for (const proc of activeProcesses) {
			proc.kill("SIGTERM");
		}
		setTimeout(() => {
			for (const proc of activeProcesses) {
				if (!proc.killed) proc.kill("SIGKILL");
			}
			activeProcesses.clear();
		}, 2000);
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

	/** Get the vault's absolute filesystem path. Requires a desktop vault on the local filesystem. */
	private getVaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("WhisperCal requires a desktop vault on the local filesystem.");
		}
		return adapter.getBasePath();
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
		// Drop the removed llmSpeakerTagFallback toggle from older data files — the
		// post-processing prompt path is now the LLM on/off switch.
		delete (this.settings as unknown as Record<string, unknown>)["llmSpeakerTagFallback"];
		// Repoint installs still on the previous default speaker-tagging prompt to the new
		// in-place post-processing prompt. The old "Speaker Auto-Tag" prompt only proposed
		// names; the new default also fixes transcription/diarization errors in the body.
		// Only the exact old default is migrated — a custom or deliberately-chosen path is
		// left alone. installBundledPrompts (onLayoutReady) writes the new file if missing.
		if (this.settings.speakerTaggingPromptPath === "Prompts/Speaker Auto-Tag Prompt.md") {
			this.settings.speakerTaggingPromptPath = DEFAULT_SETTINGS.speakerTaggingPromptPath;
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
		if (hasTranscriptTag && fm[FM.MACWHISPER_SESSION_ID]) {
			return file;
		}

		// Context A: meeting note with a linked transcript
		if (fm[FM.CALENDAR_EVENT_ID] && fm[FM.MACWHISPER_SESSION_ID] && fm[FM.TRANSCRIPT]) {
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
		customInstructions?: string,
		opts?: {auto?: boolean},
	): Promise<void> {
		// Auto mode (background run from AutoSpeakerTagger): no modals, no
		// Notices at the guards — caching proposals is the end of the run.
		// NOTE: this path must stay synchronous up to runLlmJob so the LLM
		// slot pre-checked by the auto queue can't be raced away.
		const auto = opts?.auto ?? false;
		const transcriptPath = transcriptFile.path;
		const state = readFmString(transcriptFm, FM.PIPELINE_STATE);
		if (state && state !== "titled") {
			if (auto) return;
			new Notice("Speakers already tagged for this transcript");
			// Heal: ensure the meeting note also reflects at least "tagged"
			void updateFrontmatter(this.app, notePath, FM.PIPELINE_STATE, "tagged");
			return;
		}

		// Check for cached LLM proposals from a previous run (e.g. modal was dismissed)
		if (hasCachedProposals(this.app, transcriptPath)) {
			if (auto) return;
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

		// Native deterministic cleanup first: word replacements run before anything reads the
		// body, so the LLM (and the modal) see the corrected text. The LLM then handles the
		// context-dependent transcription + diarization fixes the replacement list can't.
		// Then embeddings-first speaker identity: match each body label against the enrolled
		// voiceprint libraries. The LLM post-processing pass runs whenever it's enabled and a
		// prompt is configured (the prompt path is the on/off switch); confident voiceprint
		// hits are passed as fixed CERTAIN anchors so the LLM only names the rest. With no
		// prompt (or LLM off) we stay LLM-free: known people are pre-filled and unknowns are
		// confirmed by ear in the modal.
		// Decide the LLM path up front (pure settings reads) and claim a concurrency slot
		// *synchronously*, before the async pre-work below. The auto-tagger pre-checks a free
		// slot and enters here with no await in between, so claiming now makes that
		// check-then-use atomic. Without it, a manual job could take the last slot during the
		// pre-work awaits, bouncing the auto run after it was already marked attempted — a
		// silent drop. The LLM-free path claims nothing (no LLM runs); the claim is handed to
		// runLlmJob (preClaimed) or released at the early return below.
		const runLlm = this.settings.llmEnabled && !!this.settings.speakerTaggingPromptPath;
		let slotClaimed = false;
		if (runLlm) {
			if (this.activeLlmCount >= this.settings.llmMaxConcurrent) {
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				if (!auto) new Notice("LLM concurrency limit reached — try again when a running job finishes");
				return;
			}
			this.activeLlmCount++;
			slotClaimed = true;
		}

		let voiceprintMatches: string | undefined;
		let preBody: string | undefined; // file snapshot taken just before the LLM edits it, for failure-restore
		try {
			if (this.settings.replacementFilePath) {
				const wr = await applyWordReplacements(this.app, transcriptPath, this.settings.replacementFilePath);
				if (wr.totalCount > 0) console.debug(`[WhisperCal] Applied ${wr.totalCount} word replacement(s) before post-processing`);
			}
			const content = await this.app.vault.cachedRead(transcriptFile);
			preBody = content;
			const baseMappings = buildMappingsFromBody(content);
			const vp = baseMappings.length > 0
				? await matchVoiceprints(this.app, this.settings.voiceprintFolderPath, transcriptPath, baseMappings)
				: new Map<string, VoiceprintMatch>();
			if (!runLlm) {
				// LLM-free path: cache the voiceprint matches (if any) and confirm by ear.
				if (baseMappings.length > 0) await writeSpeakerProposals(this.app, transcriptPath, baseMappings);
				if (auto) {
					if (vp.size > 0) this.setCardStatus(notePath, `${vp.size} speaker(s) matched by voiceprint — review`, "users-round", 6000, "done");
					return;
				}
				if (baseMappings.length === 0) {
					new Notice("No speakers found in the transcript");
					return;
				}
				void this.presentSpeakerTagModal(baseMappings, transcriptFile, transcriptPath, notePath, vp);
				return;
			}
			// LLM path: pass the confident voiceprint hits so the prompt treats them as fixed
			// CERTAIN anchors and only works the unmatched labels; the modal re-matches
			// afterward, so acoustic matches still win regardless.
			if (vp.size > 0) {
				voiceprintMatches = Array.from(vp.entries())
					.map(([label, match]) => `${label} = ${match.name}`)
					.join("; ");
			}
		} catch (e) {
			console.warn("[WhisperCal] pre-LLM cleanup/voiceprint step failed", e);
		}

		// Only spawn the LLM when we have a snapshot to restore from. Reaching here without
		// runLlm means the LLM-free path already handled the run (and returned); without
		// preBody means the read failed. Either way, release the claimed slot and stop.
		if (!runLlm || preBody === undefined) {
			if (slotClaimed) this.activeLlmCount--;
			if (!auto) new Notice("Could not read the transcript for post-processing");
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
			jobKind: "speakerTag",
			filePath: transcriptPath,
			label: "Post-processing transcript",
			promptPath: this.settings.speakerTaggingPromptPath,
			preClaimed: slotClaimed,
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
				llmPromptFlags: this.settings.speakerTagFlags || undefined,
				llmModel: this.settings.speakerTagModel || undefined,
				transcriptFolderPath: this.settings.transcriptFolderPath || undefined,
				peopleFolderPath: this.settings.peopleFolderPath || undefined,
				calendarAttendees,
				peopleRoster,
				voiceprintMatches,
				additionalInstructions: customInstructions,
				outputFormat: 'Output format: After your edits, end your final message with ONLY a fenced JSON code block in this schema: {"speakers":[{"index":0,"original_name":"<verbatim stub label>","proposed_name":"<full name, or JSON null>","confidence":"CERTAIN|HIGH|LOW, or JSON null","evidence":"..."}]}. Use the value null (never the string "null") when unknown. No other text after the JSON block.',
				timeoutMs: this.settings.llmTimeoutMinutes > 0 ? this.settings.llmTimeoutMinutes * 60000 : 0,
				debugMode: this.settings.llmDebugMode,
				debugLogging: this.settings.llmDebugLogging,
			}),
			onSuccess: (result) => {
				// runLlmJob calls onSuccess even on nonzero exit (after logging the error to
				// the note). Because the LLM now edits the transcript in place, a crash/timeout
				// can leave a half-rewritten file — revert to the pre-LLM snapshot.
				if (result.exitCode !== 0) {
					void this.restoreTranscriptBody(transcriptPath, preBody, notePath, auto);
					return;
				}
				void this.handleSpeakerTagSuccess(result.stdout, transcriptFile, transcriptPath, notePath, auto, preBody);
			},
		});
	}

	private async handleSpeakerTagSuccess(stdout: string, transcriptFile: TFile, transcriptPath: string, notePath: string, auto = false, snapshot?: string): Promise<void> {
		// Clear the "Post-processing transcript…" progress status now that the LLM is done.
		// Success/error paths below will set their own status as needed.
		const clearProgressStatus = () => this.clearProgressStatus(notePath);

		// Verify the transcript file still exists after the LLM run
		if (!this.app.vault.getAbstractFileByPath(transcriptPath)) {
			if (auto) {
				this.setCardStatus(notePath, "Transcript was deleted while post-processing was running", "alert-circle", 8000, "warning");
				return;
			}
			new Notice("Transcript was deleted while post-processing was running");
			clearProgressStatus();
			return;
		}

		// Catastrophic-deletion tripwire: the LLM edits the body in place, so a rogue run could
		// delete real speech. Use two independent collapse signals to tell a real catastrophe
		// from a heavy-but-legitimate cleanup:
		//   - words: echo/catch-all removal (a mic channel that echoed everyone) can legitimately
		//     drop a large share of words, so a word collapse ALONE is not enough to revert.
		//   - speakers: that same cleanup only removes echo labels — every real diarized speaker
		//     survives. A catastrophe deletes whole speakers, collapsing the distinct-label set.
		// Revert only when BOTH collapse together, or when almost nothing survives at all (a
		// near-total loss no real transcript reaches — covers a gutted body that kept its labels).
		if (snapshot !== undefined) {
			const WORD_FLOOR = 0.34;   // revert candidate when fewer than this fraction of words remain …
			const LABEL_FLOOR = 0.5;   // … AND fewer than this fraction of the distinct speaker labels remain
			const MIN_REAL_WORDS = 30; // a real transcript body always clears this; below it = gutted
			try {
				const current = await this.app.vault.read(transcriptFile);
				const beforeWords = bodyWordCount(snapshot);
				const afterWords = bodyWordCount(current);
				const beforeLabels = distinctSpeakerLabels(snapshot);
				const afterLabels = distinctSpeakerLabels(current);
				const wordsCollapsed = beforeWords > 0 && afterWords < beforeWords * WORD_FLOOR;
				const labelsCollapsed = beforeLabels > 0 && afterLabels < beforeLabels * LABEL_FLOOR;
				const nearTotalLoss = beforeWords >= MIN_REAL_WORDS && afterWords < MIN_REAL_WORDS;
				if ((wordsCollapsed && labelsCollapsed) || nearTotalLoss) {
					await this.restoreTranscriptBody(transcriptPath, snapshot, notePath, auto, "Transcript post-processing removed too much text — transcript restored");
					return;
				}
			} catch (e) {
				console.warn("[WhisperCal] post-processing deletion check failed", e);
			}
		}

		const {mappings, warning} = parseSpeakerTagOutput(stdout, this.app, transcriptPath);
		if (warning) {
			console.warn("[WhisperCal]", warning);
		}
		if (mappings.length === 0) {
			if (auto) {
				this.setCardStatus(notePath, warning || "LLM returned no speaker mappings — check the prompt and transcript", "alert-circle", 8000, "warning");
				return;
			}
			new Notice(warning || "LLM returned no speaker mappings — check the prompt and transcript");
			clearProgressStatus();
			return;
		}
		if (warning && !auto) {
			new Notice(warning);
		}

		// Cache proposals in transcript frontmatter so they survive modal dismissal
		await writeSpeakerProposals(this.app, transcriptPath, mappings);
		// Proposals don't change any FM_KEYS the calendar listener dedupes on,
		// so refresh explicitly to surface the candidates-ready dot (this also
		// fixes the dot after a manual run's modal is dismissed).
		this.refreshCalendarCards(transcriptPath);

		if (auto) {
			// Automatic mode stops here: candidates are cached, never applied.
			// The user reviews via the Speakers pill, which is also what gates
			// auto-summarize (inside presentSpeakerTagModal, after apply).
			this.setCardStatus(notePath, "Speaker candidates ready — click Speakers to review", "users-round", 8000, "done");
			return;
		}

		await this.presentSpeakerTagModal(mappings, transcriptFile, transcriptPath, notePath);
	}

	/**
	 * Revert a transcript to a pre-LLM snapshot after a failed or over-aggressive
	 * post-processing run, then surface the outcome. Best-effort — a missing file or
	 * write error is logged, not thrown.
	 */
	private async restoreTranscriptBody(
		transcriptPath: string,
		snapshot: string | undefined,
		notePath: string,
		auto: boolean,
		message = "Transcript post-processing failed — transcript restored",
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(transcriptPath);
		if (snapshot !== undefined && file instanceof TFile) {
			try {
				await this.app.vault.modify(file, snapshot);
			} catch (e) {
				console.error("[WhisperCal] failed to restore transcript snapshot", e);
			}
		}
		if (auto) {
			this.setCardStatus(notePath, message, "alert-circle", 8000, "warning");
		} else {
			new Notice(message);
		}
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
		preMatched?: Map<string, VoiceprintMatch>,
	): Promise<void> {
		const clearProgressStatus = () => this.clearProgressStatus(notePath);

		// Always read transcript content — needed for line-count enrichment and excerpt panel
		const transcriptContent = await this.app.vault.cachedRead(transcriptFile);

		// Enrich line counts from body text when frontmatter lacks them (e.g. Tome transcripts)
		if (mappings.some(m => m.lineCount === 0)) {
			enrichLineCountsFromBody(mappings, transcriptContent);
		}

		// Match speakers against enrolled voiceprints and pre-fill confident hits as CERTAIN.
		// Captured so a user override of a match can heal the library on apply. Best-effort.
		// The default (LLM-off) path already matched these same mappings to decide whether
		// the LLM was needed — reuse that result instead of scanning the libraries again.
		let vpProposals = preMatched ?? new Map<string, VoiceprintMatch>();
		if (!preMatched) {
			try {
				vpProposals = await matchVoiceprints(this.app, this.settings.voiceprintFolderPath, transcriptPath, mappings);
			} catch (e) {
				console.warn("[WhisperCal] voiceprint matching failed", e);
			}
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
				// Resolve the linked recording (Tome writes `recording: [[...m4a]]` to the
				// transcript frontmatter) so the modal can offer click-to-play per timestamp.
				const transcriptFm = this.app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {};
				const audioFile = resolveWikiLink(this.app, transcriptFm, "recording", transcriptPath);
				// Curated attendee names to prefill the modal's dropdowns. Source from the
				// parent meeting note (the source of truth), falling back to the transcript copy.
				const inviteeRaw = (Array.isArray(meetingFm[FM.MEETING_INVITEES]) ? meetingFm[FM.MEETING_INVITEES]
					: Array.isArray(transcriptFm[FM.MEETING_INVITEES]) ? transcriptFm[FM.MEETING_INVITEES]
					: []) as unknown[];
				const meetingInvitees = inviteeRaw
					.filter((v): v is string => typeof v === "string")
					.map(v => stripWikiLink(v))
					.filter(Boolean);
				const decisions = await new SpeakerTagModal(this.app, mappings, title, subtitle, this.settings.peopleFolderPath, transcriptContent, audioFile, this.settings.speakerTagClipSeconds, meetingInvitees).prompt();
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

				// Enroll acoustic voiceprints for the confirmed speakers when Tome wrote a
				// sidecar next to this transcript. Best-effort — never blocks tagging.
				try {
					const enroll = await enrollVoiceprints(
						this.app,
						this.settings.voiceprintFolderPath,
						transcriptPath,
						decisions,
						new Date().toISOString().slice(0, 10),
					);
					if (enroll.enrolled.length > 0) {
						new Notice(`Enrolled voiceprint for ${enroll.enrolled.length} speaker(s)`);
					}
					if (enroll.corrected > 0) {
						new Notice(`Updated ${enroll.corrected} voiceprint librar${enroll.corrected === 1 ? "y" : "ies"} after re-tagging`);
					}
				} catch (e) {
					console.warn("[WhisperCal] voiceprint enrollment failed", e);
				}

				// Self-heal: if you overrode a voiceprint match, drop the culprit sample from
				// the wrongly-matched person's library so it stops causing false matches.
				try {
					const healed = await healVoiceprints(this.app, this.settings.voiceprintFolderPath, transcriptPath, decisions, vpProposals);
					if (healed > 0) new Notice(`Corrected ${healed} voiceprint${healed === 1 ? "" : "s"}`);
				} catch (e) {
					console.warn("[WhisperCal] voiceprint heal failed", e);
				}

				// Apply word replacements now that real names are in the body (stub→name can
				// expose new matches). Silent, like the other pipeline passes — a Notice belongs
				// only to the explicit "Run word replacements" command, not a tagging side effect.
				if (this.settings.replacementFilePath) {
					const result = await applyWordReplacements(this.app, transcriptPath, this.settings.replacementFilePath);
					if (result.totalCount > 0) {
						console.debug(`[WhisperCal] Applied ${result.totalCount} word replacement(s) to transcript`);
					}
				}

				// Directly update meeting note pipeline_state rather than
				// waiting for the async metadataCache mirror event.
				await updateFrontmatter(this.app, notePath, FM.PIPELINE_STATE, "tagged");
				this.setCardStatus(notePath, "Speakers tagged", "check", 4000, "done");

				// Auto-summarize if enabled
				if (this.settings.autoSummarizeAfterTagging && this.settings.summarizerPromptPath) {
					void this.doSummarize(notePath, true);
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
	 * Open the speaker review modal from the transcript's current frontmatter. Serves both the
	 * green "candidates ready" badge (cached proposals) and the hover "+" on an already-tagged
	 * transcript (existing assignments, pre-filled). No LLM runs — the modal's Apply re-labels
	 * the body and re-writes the tags.
	 */
	private reviewSpeakerCandidates(notePath: string): void {
		const transcriptFile = getLinkedTranscriptFile(this.app, notePath);
		if (!transcriptFile) {
			new Notice("No linked transcript found");
			return;
		}
		const mappings = buildMappingsFromCache(this.app, transcriptFile.path);
		if (mappings.length === 0) {
			new Notice("No speakers found in the transcript");
			return;
		}
		void this.presentSpeakerTagModal(mappings, transcriptFile, transcriptFile.path, notePath);
	}

	/**
	 * Reset pipeline_state to "tagged" on the meeting note and its linked
	 * transcript so the summarizer prompt's Step 4 gate sees a clean "tagged"
	 * state and proceeds without prompting the user to confirm a re-run.
	 * The plugin then sets pipeline_state back to "summarized" on success.
	 */
	private async regenerateSummary(notePath: string, customInstructions?: string): Promise<void> {
		const noteFile = this.app.vault.getAbstractFileByPath(notePath);
		if (!(noteFile instanceof TFile)) {
			new Notice("Meeting note not found");
			return;
		}
		if (this.jobs.has("summarize", notePath)) {
			new Notice("Summarization already in progress");
			return;
		}
		await updateFrontmatter(this.app, notePath, FM.PIPELINE_STATE, "tagged");
		const transcriptFile = getLinkedTranscriptFile(this.app, notePath);
		if (transcriptFile) {
			await updateFrontmatter(this.app, transcriptFile.path, FM.PIPELINE_STATE, "tagged");
		}
		await this.doSummarize(notePath, true, customInstructions);
	}

	private async doSummarize(notePath: string, skipPipelineCheck = false, customInstructions?: string): Promise<void> {
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
			const pipelineState = readFmString(fm, FM.PIPELINE_STATE);
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
			jobKind: "summarize",
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
				llmPromptFlags: this.settings.summarizerFlags || undefined,
				llmModel: this.settings.summarizerModel || undefined,
				additionalInstructions: customInstructions,
				timeoutMs: this.settings.llmTimeoutMinutes > 0 ? this.settings.llmTimeoutMinutes * 60000 : 0,
				debugMode: this.settings.llmDebugMode,
				debugLogging: this.settings.llmDebugLogging,
			}),
			onSuccess: async ({exitCode, stderr}) => {
				if (exitCode === 0) {
					if (!this.app.vault.getAbstractFileByPath(notePath)) {
						new Notice("Meeting note was deleted while summarization was running");
					} else {
						// Plugin owns pipeline_state on success — the LLM editing it
						// directly has historically dropped adjacent frontmatter fields.
						await updateFrontmatter(this.app, notePath, FM.PIPELINE_STATE, "summarized");
						const transcriptFile = getLinkedTranscriptFile(this.app, notePath);
						if (transcriptFile) {
							await updateFrontmatter(this.app, transcriptFile.path, FM.PIPELINE_STATE, "summarized");
						}
						this.setCardStatus(notePath, "Summarization complete", "check", 4000, "done");
						// Meeting is fully processed — collapse the card to hide its
						// action buttons, mirroring a manual carat collapse.
						this.collapseCalendarCard(notePath);
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
				jobKind: "research",
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
						? {inlinePrompt: `Use the Edit tool to add a "## Research" section to the meeting note (replace the existing ## Research section if one is present). Do your research first, then make a single Edit call to write the section. Do not just print the results — they must be written into the file. Instructions: ${result.instructions}`}
						: {promptPath: this.settings.researchPromptPath}),
					llmCli: this.settings.llmCli,
					llmExtraFlags: this.settings.llmExtraFlags,
					llmPromptFlags: this.settings.researchFlags || undefined,
					llmModel: this.settings.researchModel || undefined,
					researchNotePaths: result.paths.length > 0 ? result.paths : undefined,
					additionalInstructions: result.bypassPrompt ? undefined : (result.instructions || undefined),
					peopleFolderPath: this.settings.peopleFolderPath || undefined,
					timeoutMs: this.settings.llmTimeoutMinutes > 0 ? this.settings.llmTimeoutMinutes * 60000 : 0,
					debugMode: this.settings.llmDebugMode,
					debugLogging: this.settings.llmDebugLogging,
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
		jobKind: JobKind;
		filePath: string;
		label: string;
		promptPath?: string;
		spawnOpts: (vaultPath: string) => Omit<Parameters<typeof spawnLlmPrompt>[0], "configDir">;
		onSuccess: (result: {exitCode: number; stdout: string; stderr: string}) => void | Promise<void>;
		onRegister?: () => void;
		onCleanup?: () => void;
		/** Icon for card status (e.g. "sparkles", "users-round", "book-open") */
		cardIcon?: string;
		/** Model ID for card status suffix (e.g. "claude-opus-4-6") */
		cardModel?: string;
		/** Note path for card status (defaults to filePath) */
		cardNotePath?: string;
		/** The caller already claimed an activeLlmCount slot (see doTagSpeakers).
		 *  Skip the concurrency check/increment here, but release it on an early return. */
		preClaimed?: boolean;
	}): void {
		const {jobKind, filePath, label, promptPath, preClaimed} = opts;

		// Release a caller-claimed slot when we bail before the async run (whose finally
		// owns the matching decrement) takes over.
		const releaseClaim = () => { if (preClaimed) this.activeLlmCount--; };

		if (!this.settings.llmEnabled) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("LLM features are disabled — enable them in WhisperCal settings");
			releaseClaim();
			return;
		}
		if (this.jobs.has(jobKind, filePath)) {
			new Notice(`${label} already in progress`);
			releaseClaim();
			return;
		}
		if (!preClaimed && this.activeLlmCount >= this.settings.llmMaxConcurrent) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("LLM concurrency limit reached — try again when a running job finishes");
			return;
		}

		// Register job synchronously before any async work. The slot was claimed either by
		// the caller (preClaimed) or here; the run's finally block does the single decrement.
		this.jobs.add(jobKind, filePath);
		if (!preClaimed) this.activeLlmCount++;

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

				const result = await spawnLlmPrompt({
					...opts.spawnOpts(vaultPath),
					configDir: this.app.vault.configDir,
				});

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

				void opts.onSuccess(result);
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
				this.jobs.remove(jobKind, filePath);
				this.activeLlmCount--;
				this.clearProgressStatus(statusNotePath);
				this.refreshCalendarCards(filePath);
				opts.onCleanup?.();
			}
		})();
	}

	private setCardStatus(notePath: string, message: string, icon?: string, durationMs = 4000, variant?: CardStatusVariant): void {
		this.cardUi.setStatus(notePath, {message, icon, variant});
		this.refreshCalendarCards(notePath);
		if (durationMs > 0) {
			setTimeout(() => {
				if (this.cardUi.getStatus(notePath)?.message === message) {
					this.cardUi.deleteStatus(notePath);
					this.refreshCalendarCards(notePath);
				}
			}, durationMs);
		}
	}

	private clearProgressStatus(notePath: string): void {
		const cs = this.cardUi.getStatus(notePath);
		if (cs?.variant === "progress") {
			this.cardUi.deleteStatus(notePath);
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

	/** Collapse a meeting's calendar card across all open calendar leaves. */
	private collapseCalendarCard(notePath: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) {
				view.collapseCard(notePath);
			}
		}
	}

	private static readonly BANNER_CLS = "whisper-cal-llm-banner";

	private static readonly BANNER_OPS: {kind: JobKind; op: string; label: string}[] = [
		{kind: "summarize", op: "summarize", label: "Summarizing\u2026"},
		{kind: "speakerTag", op: "speakers", label: "Post-processing transcript\u2026"},
		{kind: "research", op: "research", label: "Researching\u2026"},
	];

	/** Add or remove LLM banners for all leaves showing the given file. */
	private updateBanners(filePath: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === filePath) {
				for (const {kind, op, label} of WhisperCalPlugin.BANNER_OPS) {
					if (this.jobs.has(kind, filePath)) {
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
				for (const {kind, op, label} of WhisperCalPlugin.BANNER_OPS) {
					if (this.jobs.has(kind, view.file.path)) {
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
		if (fm[FM.MACWHISPER_SESSION_ID]) {
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
		const isUnscheduled = fm[FM.CALENDAR_EVENT_ID] === "unscheduled";

		// Extract attendee names from frontmatter (stored as wiki links or plain strings)
		const rawAttendees = Array.isArray(fm[FM.MEETING_INVITEES]) ? fm[FM.MEETING_INVITEES] as string[] : [];
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
					this.cardUi.deleteStatus(file.path);
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
