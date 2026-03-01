import {MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf} from "obsidian";
import {DEFAULT_SETTINGS, WhisperCalSettings, WhisperCalSettingTab} from "./settings";
import {VIEW_TYPE_CALENDAR, COMMAND_OPEN_CALENDAR, COMMAND_LINK_RECORDING} from "./constants";
import {CalendarView} from "./ui/CalendarView";
import {createCalendarProvider} from "./services/CalendarProvider";
import {linkRecording} from "./services/LinkRecording";
import {MsalAuth} from "./services/MsalAuth";
import type {AuthState} from "./services/AuthTypes";
import type {TokenCache} from "./services/AuthTypes";
import type {CalendarProvider} from "./types";

interface PluginData extends WhisperCalSettings {
	tokenCache?: TokenCache | null;
}

export default class WhisperCalPlugin extends Plugin {
	settings: WhisperCalSettings;
	auth: MsalAuth;
	private provider: CalendarProvider;
	private authStateListeners: Array<(state: AuthState) => void> = [];
	private micButtonEl: HTMLElement | null = null;
	private tokenCache: TokenCache | null = null;

	async onload() {
		await this.loadSettings();

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

		this.provider = createCalendarProvider(this.auth);

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) =>
			new CalendarView(leaf, this.settings, this.provider)
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
				if (!fm?.["whisper_event_id"]) return false;
				if (checking) return true;
				void this.handleLinkRecording(file, fm);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fm?.["whisper_event_id"]) return;
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

		this.addSettingTab(new WhisperCalSettingTab(this.app, this));
	}

	onunload() {
		this.auth.cancelSignIn();
		this.removeTitleBarMicButton();
	}

	async loadSettings() {
		const data = await this.loadData() as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.tokenCache = data?.tokenCache ?? null;
	}

	async saveSettings() {
		await this.saveData({...this.settings, tokenCache: this.tokenCache});
		// Update auth config if tenant/client/cloud changed
		this.auth.updateConfig({
			tenantId: this.settings.tenantId,
			clientId: this.settings.clientId,
			cloudInstance: this.settings.cloudInstance,
		});
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
		return this.tokenCache;
	}

	private async saveTokenCache(cache: TokenCache | null): Promise<void> {
		this.tokenCache = cache;
		await this.saveData({...this.settings, tokenCache: cache});
	}

	private removeTitleBarMicButton(): void {
		if (this.micButtonEl) {
			this.micButtonEl.remove();
			this.micButtonEl = null;
		}
	}

	private updateTitleBarMicButton(): void {
		this.removeTitleBarMicButton();

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;

		const file = view.file;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm?.["whisper_event_id"]) return;

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
	}

	private async handleLinkRecording(
		file: TFile,
		fm: Record<string, unknown>,
	): Promise<void> {
		if (fm["macwhisper_session_id"]) {
			new Notice("Recording already linked to this note");
			return;
		}

		// Prefer note_created (button-press time, close to recording start)
		// over scheduled meeting_date + meeting_start
		const noteCreatedStr = fm["note_created"] as string | undefined;
		let meetingStart: Date | null = null;

		if (noteCreatedStr) {
			meetingStart = new Date(noteCreatedStr);
		}
		if (!meetingStart || isNaN(meetingStart.getTime())) {
			const rawDate = fm["meeting_date"];
			const timeStr = fm["meeting_start"] as string | undefined;
			if (rawDate && timeStr) {
				// meeting_date may be a YAML Date object (unquoted) or a string
				const dateStr = rawDate instanceof Date
					? rawDate.toISOString().slice(0, 10)
					: rawDate as string;
				meetingStart = new Date(`${dateStr} ${timeStr}`);
			}
		}
		if (!meetingStart || isNaN(meetingStart.getTime())) {
			new Notice("Missing meeting date/time in frontmatter");
			return;
		}

		const subject = (fm["whisper_subject"] as string) || file.basename;
		const isUnscheduled = fm["whisper_event_id"] === "unscheduled";

		await linkRecording({
			app: this.app,
			meetingStart,
			notePath: file.path,
			subject,
			timezone: this.settings.timezone,
			transcriptFolderPath: this.settings.transcriptFolderPath,
			windowMinutes: isUnscheduled ? 720 : undefined,
		});
	}

	private async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
		if (existing.length > 0) {
			const leaf = existing[0] as WorkspaceLeaf;
			await this.app.workspace.revealLeaf(leaf);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({type: VIEW_TYPE_CALENDAR, active: true});
			await this.app.workspace.revealLeaf(leaf);
		}
	}
}
