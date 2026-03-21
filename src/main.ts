import {MarkdownView, Notice, Plugin, TFile} from "obsidian";
import {execSync} from "child_process";
import {DEFAULT_SETTINGS, WhisperCalSettings, WhisperCalSettingTab} from "./settings";
import {VIEW_TYPE_CALENDAR, COMMAND_OPEN_CALENDAR, COMMAND_LINK_RECORDING, COMMAND_TAG_SPEAKERS, COMMAND_SUMMARIZE} from "./constants";
import {CalendarView} from "./ui/CalendarView";
import {GraphApiProvider} from "./services/GraphApiProvider";
import {linkRecording} from "./services/LinkRecording";
import {spawnLlmPrompt, validateLlmCli, resolvePromptPath, activeProcesses, stripAnsi} from "./services/LlmInvoker";
import {summarizeJobs, speakerTagJobs} from "./state";
import {parseSpeakerTagOutput} from "./services/SpeakerTagParser";
import {access} from "fs/promises";
import {SpeakerTagModal} from "./ui/SpeakerTagModal";
import {applySpeakerTags} from "./services/SpeakerTagApplier";
import {parseDateTime} from "./utils/time";
import {updateFrontmatter} from "./utils/frontmatter";
import {resolveWikiLink} from "./utils/vault";
import {MsalAuth} from "./services/MsalAuth";
import type {AuthState} from "./services/AuthTypes";
import type {TokenCache} from "./services/AuthTypes";
import type {CalendarProvider} from "./types";
import {CachedCalendarProvider} from "./services/CalendarCache";

interface PluginData extends WhisperCalSettings {
	tokenCache?: TokenCache | null;
}

export default class WhisperCalPlugin extends Plugin {
	settings: WhisperCalSettings;
	auth: MsalAuth;
	private provider: CalendarProvider;
	private cachedProvider: CachedCalendarProvider | null = null;
	private authStateListeners: Array<(state: AuthState) => void> = [];
	private tokenCache: TokenCache | null = null;

	async onload() {
		await this.loadSettings();

		this.auth = new MsalAuth(
			{
				tenantId: this.settings.tenantId,
				clientId: this.settings.clientId,
				cloudInstance: this.settings.cloudInstance,
				deviceLoginUrl: this.settings.deviceLoginUrl,
			},
			{
				loadTokenCache: () => this.loadTokenCache(),
				saveTokenCache: (cache) => this.saveTokenCache(cache),
				onStateChange: (state) => this.notifyAuthStateListeners(state),
			},
		);
		this.auth.initialize();

		const upstream = new GraphApiProvider(this.auth);
		this.cachedProvider = new CachedCalendarProvider(
			this.app,
			upstream,
			this.manifest.dir!,
			this.settings.cacheFutureDays,
			this.settings.cacheRetentionDays,
			this.settings.timezone,
		);
		await this.cachedProvider.loadCache();
		this.provider = this.cachedProvider;

		const getCacheStatus = () => this.cachedProvider?.getLastStatus() ?? null;

		const onTagSpeakers = (transcriptFile: TFile, transcriptFm: Record<string, unknown>) => {
			this.doTagSpeakers(transcriptFile, transcriptFm);
		};

		const onSummarize = (notePath: string) => {
			this.doSummarize(notePath);
		};

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) =>
			new CalendarView(leaf, this.settings, this.provider, getCacheStatus, onTagSpeakers, onSummarize)
		);

		// Mirror pipeline_state from transcript files back to their meeting notes
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (!file.path.startsWith(this.settings.transcriptFolderPath + "/")) return;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fm) return;
				const pipelineState = fm["pipeline_state"] as string | undefined;
				if (!pipelineState) return;
				// Resolve meeting note from transcript's meeting_note backlink
				const meetingNoteLink = fm["meeting_note"] as string | undefined;
				if (!meetingNoteLink || typeof meetingNoteLink !== "string") return;
				const linktext = meetingNoteLink.replace(/^\[\[/, "").replace(/\]\]$/, "");
				const meetingFile = this.app.metadataCache.getFirstLinkpathDest(linktext, file.path);
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

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- product name
		this.addRibbonIcon("mic", "Open MacWhisper", () => {
			window.open("macwhisper://reopenWindow");
		});

		this.addCommand({
			id: COMMAND_OPEN_CALENDAR,
			name: "Open calendar view",
			callback: () => {
				void this.activateView();
			},
		});

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
							void this.handleLinkRecording(file, fm);
						});
				});
			}),
		);

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
				this.doTagSpeakers(transcriptFile, transcriptFm as Record<string, unknown>);
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

		// Show/hide summarize banner when switching between notes
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.updateAllSummarizeBanners()),
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
	}


	async loadSettings() {
		const data = await this.loadData() as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.tokenCache = data?.tokenCache ?? null;
		// Auto-populate microphoneUser from macOS account on first install
		if (!this.settings.microphoneUser) {
			try {
				this.settings.microphoneUser = execSync("id -F", {encoding: "utf-8"}).trim();
				await this.saveData({...this.settings, tokenCache: this.tokenCache});
			} catch {
				// Leave empty — user can fill in manually
			}
		}
	}

	async saveSettings() {
		await this.saveData({...this.settings, tokenCache: this.tokenCache});
		// Update auth config if tenant/client/cloud changed
		this.auth.updateConfig({
			tenantId: this.settings.tenantId,
			clientId: this.settings.clientId,
			cloudInstance: this.settings.cloudInstance,
			deviceLoginUrl: this.settings.deviceLoginUrl,
		});
		// Update cache config
		this.cachedProvider?.updateConfig(
			this.settings.cacheFutureDays,
			this.settings.cacheRetentionDays,
			this.settings.timezone,
		);
		// Update existing views with new settings
		const getCacheStatus = () => this.cachedProvider?.getLastStatus() ?? null;
		const onTagSpeakers = (transcriptFile: TFile, transcriptFm: Record<string, unknown>) => {
			this.doTagSpeakers(transcriptFile, transcriptFm);
		};
		const onSummarize = (notePath: string) => {
			this.doSummarize(notePath);
		};
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) {
				view.updateSettings(this.settings, this.provider, getCacheStatus, onTagSpeakers, onSummarize);
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
		return this.tokenCache;
	}

	private async saveTokenCache(cache: TokenCache | null): Promise<void> {
		this.tokenCache = cache;
		await this.saveData({...this.settings, tokenCache: cache});
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

	private doTagSpeakers(
		transcriptFile: TFile,
		transcriptFm: Record<string, unknown>,
	): void {
		const transcriptPath = transcriptFile.path;
		const state = transcriptFm["pipeline_state"] as string | undefined;
		if (state && state !== "titled") {
			new Notice("Speakers already tagged for this transcript");
			return;
		}
		if (!transcriptFm["macwhisper_session_id"]) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("Transcript is missing a MacWhisper session ID — try re-linking the recording");
			return;
		}
		if (!this.settings.speakerTaggingPromptPath) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("Speaker tagging prompt not configured — set it in WhisperCal settings");
			return;
		}
		if (speakerTagJobs.has(transcriptPath)) {
			new Notice("Speaker tagging already in progress for this transcript");
			return;
		}
		if (this.activeLlmCount >= this.settings.llmMaxConcurrent) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("LLM concurrency limit reached — try again when a running job finishes");
			return;
		}

		void this.runTagSpeakers(transcriptFile, transcriptPath);
	}

	private async runTagSpeakers(transcriptFile: TFile, transcriptPath: string): Promise<void> {
		// basePath is undocumented but stable on desktop — no Vault API alternative
		// exists for obtaining the absolute filesystem path to the vault root.
		const vaultPath = (this.app.vault.adapter as unknown as {basePath: string}).basePath;

		// Validate CLI exists
		if (!await validateLlmCli(this.settings.llmCli)) {
			new Notice(`LLM CLI '${this.settings.llmCli}' not found — check WhisperCal settings`);
			return;
		}

		// Validate prompt file exists
		const resolvedPrompt = resolvePromptPath(this.settings.speakerTaggingPromptPath, vaultPath);
		try {
			await access(resolvedPrompt);
		} catch {
			new Notice(`Speaker tagging prompt file not found: ${resolvedPrompt}`);
			return;
		}

		speakerTagJobs.add(transcriptPath);
		this.activeLlmCount++;
		this.refreshCalendarCards();
		new Notice("Speaker tagging started");

		const timeoutMs = this.settings.llmTimeoutMinutes > 0
			? this.settings.llmTimeoutMinutes * 60000 : 0;

		try {
			const {exitCode, stdout, stderr} = await spawnLlmPrompt({
				targetPath: transcriptPath,
				targetLabel: "Transcript",
				vaultPath,
				promptPath: this.settings.speakerTaggingPromptPath,
				microphoneUser: this.settings.microphoneUser,
				llmCli: this.settings.llmCli,
				llmExtraFlags: this.settings.llmExtraFlags,
				llmSkipPermissions: this.settings.llmSkipPermissions,
					transcriptFolderPath: this.settings.transcriptFolderPath || undefined,
				peopleFolderPath: this.settings.peopleFolderPath || undefined,
				batch: true,
				timeoutMs,
			});

			if (exitCode !== 0) {
				const excerpt = stripAnsi(stderr.trim()).slice(0, 200);
				new Notice(`Speaker tagging failed (exit ${exitCode})${excerpt ? ": " + excerpt : ""}`);
				return;
			}

			// Verify the transcript file still exists after the LLM run
			if (!this.app.vault.getAbstractFileByPath(transcriptPath)) {
				new Notice("Transcript was deleted while speaker tagging was running");
				return;
			}

			const {mappings, warning} = parseSpeakerTagOutput(stdout, this.app, transcriptPath);
			if (warning) {
				console.warn("[WhisperCal]", warning);
			}
			if (mappings.length === 0) {
				new Notice(warning || "LLM returned no speaker mappings — check the prompt and transcript");
				return;
			}
			if (warning) {
				new Notice(warning);
			}

			// Queue the modal so parallel completions are presented one at a time
			this.speakerTagModalQueue = this.speakerTagModalQueue.then(async () => {
				const title = transcriptFile.basename;
				const decisions = await new SpeakerTagModal(this.app, mappings, title).prompt();
				if (!decisions) return;

				const hasTagged = decisions.some(d => d.confirmedName);
				if (!hasTagged) {
					new Notice("No speakers tagged — no changes made");
					return;
				}

				try {
					await applySpeakerTags(this.app, transcriptPath, decisions);
					new Notice("Speaker tags applied");

					// Auto-summarize if enabled
					if (this.settings.autoSummarizeAfterTagging && this.settings.summarizerPromptPath) {
						const tFm = this.app.metadataCache.getFileCache(transcriptFile)?.frontmatter;
						const meetingLink = tFm?.["meeting_note"] as string | undefined;
						if (meetingLink) {
							const linktext = meetingLink.replace(/^\[\[/, "").replace(/\]\]$/, "");
							const meetingFile = this.app.metadataCache.getFirstLinkpathDest(linktext, transcriptPath);
							if (meetingFile) {
								this.doSummarize(meetingFile.path);
							}
						}
					}
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					new Notice(`Failed to apply speaker tags: ${msg}`);
				}
				this.refreshCalendarCards();
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Speaker tagging encountered an unexpected error: ${msg}`);
			console.error("[WhisperCal] Speaker tagging error:", e);
		} finally {
			speakerTagJobs.delete(transcriptPath);
			this.activeLlmCount--;
			this.refreshCalendarCards();
		}
	}

	private doSummarize(notePath: string): void {
		const noteFile = this.app.vault.getAbstractFileByPath(notePath);
		if (!(noteFile instanceof TFile)) {
			new Notice("Meeting note not found");
			return;
		}
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
		if (!this.settings.summarizerPromptPath) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("Summarizer prompt not configured — set it in WhisperCal settings");
			return;
		}
		if (summarizeJobs.has(notePath)) {
			new Notice("Summarization already in progress for this meeting");
			return;
		}
		if (this.activeLlmCount >= this.settings.llmMaxConcurrent) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("LLM concurrency limit reached — try again when a running job finishes");
			return;
		}

		void this.runSummarize(notePath);
	}

	private async runSummarize(notePath: string): Promise<void> {
		const vaultPath = (this.app.vault.adapter as unknown as {basePath: string}).basePath;

		// Validate CLI exists
		if (!await validateLlmCli(this.settings.llmCli)) {
			new Notice(`LLM CLI '${this.settings.llmCli}' not found — check WhisperCal settings`);
			return;
		}

		// Validate prompt file exists
		const resolvedPrompt = resolvePromptPath(this.settings.summarizerPromptPath, vaultPath);
		try {
			await access(resolvedPrompt);
		} catch {
			new Notice(`Summarizer prompt file not found: ${resolvedPrompt}`);
			return;
		}

		summarizeJobs.add(notePath);
		this.activeLlmCount++;
		this.refreshCalendarCards();
		this.updateSummarizeBanners(notePath);
		new Notice("Summarization started");

		const timeoutMs = this.settings.llmTimeoutMinutes > 0
			? this.settings.llmTimeoutMinutes * 60000 : 0;

		try {
			const {exitCode, stderr} = await spawnLlmPrompt({
				targetPath: notePath,
				targetLabel: "Meeting note",
				vaultPath,
				promptPath: this.settings.summarizerPromptPath,
				llmCli: this.settings.llmCli,
				llmExtraFlags: this.settings.llmExtraFlags,
				llmSkipPermissions: this.settings.llmSkipPermissions,
					timeoutMs,
			});

			if (exitCode === 0) {
				// Verify note still exists
				if (!this.app.vault.getAbstractFileByPath(notePath)) {
					new Notice("Meeting note was deleted while summarization was running");
				} else {
					new Notice("Summarization complete");
				}
			} else {
				const excerpt = stripAnsi(stderr.trim()).slice(0, 200);
				new Notice(`Summarization failed (exit ${exitCode})${excerpt ? ": " + excerpt : ""}`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Summarization encountered an unexpected error: ${msg}`);
			console.error("[WhisperCal] Summarization error:", e);
		} finally {
			summarizeJobs.delete(notePath);
			this.activeLlmCount--;
			this.refreshCalendarCards();
			this.updateSummarizeBanners(notePath);
		}
	}

	private refreshCalendarCards(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) {
				view.rerenderCards();
			}
		}
	}

	private static readonly BANNER_CLS = "whisper-cal-summarize-banner";

	/** Add or remove the summarize banner for all leaves showing the given note. */
	private updateSummarizeBanners(notePath: string): void {
		const running = summarizeJobs.has(notePath);
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === notePath) {
				if (running) {
					this.ensureBanner(view);
				} else {
					this.removeBanner(view);
				}
			}
		}
	}

	/** Refresh banners for all open markdown leaves (e.g. on tab switch). */
	private updateAllSummarizeBanners(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file) {
				if (summarizeJobs.has(view.file.path)) {
					this.ensureBanner(view);
				} else {
					this.removeBanner(view);
				}
			}
		}
	}

	private ensureBanner(view: MarkdownView): void {
		const container = view.contentEl;
		if (container.querySelector(`.${WhisperCalPlugin.BANNER_CLS}`)) return;
		const banner = container.createDiv({cls: WhisperCalPlugin.BANNER_CLS});
		banner.createSpan({cls: "whisper-cal-card-status-dot"});
		banner.createSpan({text: "Summarizing\u2026"});
		// Move to top of container
		container.prepend(banner);
	}

	private removeBanner(view: MarkdownView): void {
		view.contentEl
			.querySelectorAll(`.${WhisperCalPlugin.BANNER_CLS}`)
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
			const noteCreatedStr = fm["note_created"] as string | undefined;
			if (noteCreatedStr) {
				meetingStart = new Date(noteCreatedStr);
			}
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
			const name = String(s).replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/^"/, "").replace(/"$/, "");
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
