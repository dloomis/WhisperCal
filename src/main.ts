import {EventRef, MarkdownView, Notice, Plugin, TFile, normalizePath} from "obsidian";
import {execSync} from "child_process";
import {DEFAULT_SETTINGS, WhisperCalSettings, WhisperCalSettingTab} from "./settings";
import speakerAutoTagPrompt from "../prompts/Speaker Auto-Tag Prompt.md";
import {VIEW_TYPE_CALENDAR, COMMAND_OPEN_CALENDAR, COMMAND_LINK_RECORDING, COMMAND_TAG_SPEAKERS} from "./constants";
import {CalendarView} from "./ui/CalendarView";
import {createCalendarProvider} from "./services/CalendarProvider";
import {linkRecording} from "./services/LinkRecording";
import {invokeTagSpeakers} from "./services/LlmInvoker";
import {parseDateTime} from "./utils/time";
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
	private micButtonEl: HTMLElement | null = null;
	private tagSpeakersButtonEl: HTMLElement | null = null;
	private micWatchRef: EventRef | null = null;
	private tagSpeakersWatchRef: EventRef | null = null;
	private tokenCache: TokenCache | null = null;

	async onload() {
		await this.loadSettings();
		await this.ensurePromptFile();

		this.auth = new MsalAuth(
			{
				tenantId: this.settings.tenantId,
				clientId: this.settings.clientId,
				cloudInstance: this.settings.cloudInstance,
			},
			{
				loadTokenCache: () => this.loadTokenCache(),
				saveTokenCache: (cache) => this.saveTokenCache(cache),
				onStateChange: (state) => this.notifyAuthStateListeners(state),
			},
		);
		this.auth.initialize();

		const upstream = createCalendarProvider(this.auth);
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

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) =>
			new CalendarView(leaf, this.settings, this.provider, getCacheStatus)
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

		// Show mic button in title bar for meeting notes
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.updateTitleBarMicButton()),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.updateTitleBarMicButton()),
		);

		// Show tag speakers button in title bar for transcript/meeting notes
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.updateTagSpeakersButton()),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.updateTagSpeakersButton()),
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

		this.addSettingTab(new WhisperCalSettingTab(this.app, this));
	}

	onunload() {
		this.auth.cancelSignIn();
		this.removeTitleBarMicButton();
		this.removeTagSpeakersButton();
		void this.cachedProvider?.flush();
	}

	private async ensurePromptFile(): Promise<void> {
		const filePath = this.settings.speakerTaggingPromptPath;
		if (!filePath) return;
		const normalized = normalizePath(filePath);
		const exists = await this.app.vault.adapter.exists(normalized);
		if (exists) return;
		const dir = normalized.includes("/") ? normalized.substring(0, normalized.lastIndexOf("/")) : null;
		if (dir) await this.app.vault.adapter.mkdir(dir);
		await this.app.vault.adapter.write(normalized, speakerAutoTagPrompt);
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
		});
		// Update cache config
		this.cachedProvider?.updateConfig(
			this.settings.cacheFutureDays,
			this.settings.cacheRetentionDays,
			this.settings.timezone,
		);
		// Update existing views with new settings
		const getCacheStatus = () => this.cachedProvider?.getLastStatus() ?? null;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) {
				view.updateSettings(this.settings, this.provider, getCacheStatus);
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

	private removeTitleBarMicButton(): void {
		if (this.micWatchRef) {
			this.app.metadataCache.offref(this.micWatchRef);
			this.micWatchRef = null;
		}
		if (this.micButtonEl) {
			this.micButtonEl.remove();
			this.micButtonEl = null;
		}
	}

	private removeTagSpeakersButton(): void {
		if (this.tagSpeakersWatchRef) {
			this.app.metadataCache.offref(this.tagSpeakersWatchRef);
			this.tagSpeakersWatchRef = null;
		}
		if (this.tagSpeakersButtonEl) {
			this.tagSpeakersButtonEl.remove();
			this.tagSpeakersButtonEl = null;
		}
	}

	private resolveTranscriptFile(
		fm: Record<string, unknown>,
		sourcePath: string,
	): TFile | null {
		const raw = fm["transcript"];
		if (!raw || typeof raw !== "string" || !raw.trim()) return null;
		const linktext = raw.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
		return this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
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
			return this.resolveTranscriptFile(fm, file.path);
		}

		return null;
	}

	private updateTagSpeakersButton(): void {
		this.removeTagSpeakersButton();

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;

		const file = view.file;
		const cache = this.app.metadataCache.getFileCache(file);

		// File not yet indexed — retry when cache is ready
		if (!cache) {
			const ref = this.app.metadataCache.on("changed", (changedFile) => {
				if (changedFile.path === file.path) {
					this.app.metadataCache.offref(ref);
					this.updateTagSpeakersButton();
				}
			});
			window.setTimeout(() => this.app.metadataCache.offref(ref), 5000);
			return;
		}

		const fm = cache.frontmatter;
		const transcriptFile = this.resolveTagSpeakersContext(file, fm);
		if (!transcriptFile) return;

		// Get transcript frontmatter; retry if it's a different file not yet indexed
		let transcriptFm: Record<string, unknown>;
		if (transcriptFile.path === file.path) {
			transcriptFm = fm ?? {};
		} else {
			const transcriptCache = this.app.metadataCache.getFileCache(transcriptFile);
			if (!transcriptCache) {
				const ref = this.app.metadataCache.on("changed", (changedFile) => {
					if (changedFile.path === transcriptFile.path) {
						this.app.metadataCache.offref(ref);
						this.updateTagSpeakersButton();
					}
				});
				window.setTimeout(() => this.app.metadataCache.offref(ref), 5000);
				return;
			}
			transcriptFm = transcriptCache.frontmatter ?? {};
		}

		// Determine button state from pipeline_state
		const pipelineState = transcriptFm["pipeline_state"] as string | undefined;
		const isTagged = !!pipelineState && pipelineState !== "titled";
		const icon = isTagged ? "check" : "users";
		const label = isTagged ? "Speakers tagged" : "Tag speakers";

		this.tagSpeakersButtonEl = view.addAction(icon, label, () => {
			const freshFm = this.app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {};
			this.doTagSpeakers(transcriptFile, freshFm as Record<string, unknown>);
		});

		// Persistent watcher — flips icon when LLM writes pipeline_state to the transcript
		this.tagSpeakersWatchRef = this.app.metadataCache.on("changed", (changedFile) => {
			if (changedFile.path === transcriptFile.path) {
				this.updateTagSpeakersButton();
			}
		});
	}

	private doTagSpeakers(
		transcriptFile: TFile,
		transcriptFm: Record<string, unknown>,
	): void {
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
		// basePath is undocumented but stable on desktop — no Vault API alternative
		// exists for obtaining the absolute filesystem path to the vault root.
		const vaultPath = (this.app.vault.adapter as unknown as {basePath: string}).basePath;
		invokeTagSpeakers({
			transcriptPath: transcriptFile.path,
			vaultPath,
			promptPath: this.settings.speakerTaggingPromptPath,
			microphoneUser: this.settings.microphoneUser,
			llmCli: this.settings.llmCli,
			llmExtraFlags: this.settings.llmExtraFlags,
			llmSkipPermissions: this.settings.llmSkipPermissions,
			terminalApp: this.settings.terminalApp,
		});
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		new Notice("Opening Claude Code for speaker tagging — this may take several minutes");
	}

	private updateTitleBarMicButton(): void {
		this.removeTitleBarMicButton();

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;

		const file = view.file;
		const cache = this.app.metadataCache.getFileCache(file);

		// File not yet indexed (e.g. just created) — retry when cache is ready
		if (!cache) {
			const ref = this.app.metadataCache.on("changed", (changedFile) => {
				if (changedFile.path === file.path) {
					this.app.metadataCache.offref(ref);
					this.updateTitleBarMicButton();
				}
			});
			window.setTimeout(() => this.app.metadataCache.offref(ref), 5000);
			return;
		}

		const fm = cache.frontmatter;
		if (!fm?.["calendar_event_id"]) return;

		const alreadyLinked = !!fm["macwhisper_session_id"];
		const icon = alreadyLinked ? "check" : "mic";
		const label = alreadyLinked ? "MacWhisper recording linked" : "Link MacWhisper recording";

		this.micButtonEl = view.addAction(icon, label, () => {
			// Re-read frontmatter at click time to avoid stale closures
			const freshFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!freshFm) return;
			if (freshFm["macwhisper_session_id"]) {
				new Notice("Recording already linked to this note");
				return;
			}
			const doLink = async () => {
				try {
					await this.handleLinkRecording(file, freshFm);
					// Re-render mic button once metadataCache reflects the new frontmatter
					const ref = this.app.metadataCache.on("changed", (changedFile) => {
						if (changedFile.path === file.path) {
							this.app.metadataCache.offref(ref);
							this.updateTitleBarMicButton();
						}
					});
					// Safety: clean up if the event never fires
					window.setTimeout(() => this.app.metadataCache.offref(ref), 5000);
				} catch (err) {
					console.error("[WhisperCal] handleLinkRecording error:", err);
				}
			};
			void doLink();
		});
		this.micButtonEl.addClass("whisper-cal-mic-action");

		// Persistent watcher: update mic button when note frontmatter changes
		// (e.g. when recording is linked via the calendar card's mic icon)
		this.micWatchRef = this.app.metadataCache.on("changed", (changedFile) => {
			if (changedFile.path === file.path) {
				this.updateTitleBarMicButton();
			}
		});
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
			// meeting_date may be a YAML Date object (unquoted) or a string
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
		const rawAttendees = Array.isArray(fm["invitees"]) ? fm["invitees"] as string[] : [];
		const attendees = rawAttendees.map(s => {
			const name = String(s).replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/^"/, "").replace(/"$/, "");
			return {name, email: ""};
		});

		await linkRecording({
			app: this.app,
			meetingStart,
			notePath: file.path,
			subject,
			timezone: this.settings.timezone,
			transcriptFolderPath: this.settings.transcriptFolderPath,
			attendees,
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
