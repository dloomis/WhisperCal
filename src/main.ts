import {Plugin, WorkspaceLeaf} from "obsidian";
import {DEFAULT_SETTINGS, WhisperCalSettings, WhisperCalSettingTab} from "./settings";
import {VIEW_TYPE_CALENDAR, COMMAND_OPEN_CALENDAR} from "./constants";
import {CalendarView} from "./ui/CalendarView";
import {createCalendarProvider} from "./services/CalendarProvider";
import {MsalAuth} from "./services/MsalAuth";
import {RecordingManager} from "./services/RecordingManager";
import {TranscriptionManager} from "./services/TranscriptionManager";
import {registerRecordingCodeBlock} from "./ui/RecordingCodeBlock";
import {StatusBarRecording} from "./ui/StatusBarRecording";
import {NoteRecordingAction} from "./ui/NoteRecordingAction";
import {NoteTranscriptionAction} from "./ui/NoteTranscriptionAction";
import type {AuthState} from "./services/AuthTypes";
import type {TokenCache} from "./services/AuthTypes";
import type {CalendarProvider} from "./types";
import {sanitizeFilename} from "./utils/sanitize";
import {updateFrontmatter} from "./utils/frontmatter";

interface PluginData extends WhisperCalSettings {
	tokenCache?: TokenCache | null;
}

export default class WhisperCalPlugin extends Plugin {
	settings: WhisperCalSettings;
	auth: MsalAuth;
	private provider: CalendarProvider;
	private recordingManager: RecordingManager;
	private transcriptionManager: TranscriptionManager;
	private statusBarRecording: StatusBarRecording | null = null;
	private noteRecordingAction: NoteRecordingAction | null = null;
	private noteTranscriptionAction: NoteTranscriptionAction | null = null;
	private authStateListeners: Array<(state: AuthState) => void> = [];

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

		this.recordingManager = new RecordingManager(this.app, {
			recordingFolderPath: this.settings.recordingFolderPath,
			systemAudioDeviceId: this.settings.systemAudioDeviceId,
		});

		this.transcriptionManager = new TranscriptionManager(this.app, {
			transcriptionFolderPath: this.settings.transcriptionFolderPath,
			assemblyAiBaseUrl: this.settings.assemblyAiBaseUrl,
			assemblyAiApiKey: this.settings.assemblyAiApiKey,
			assemblyAiSpeechModel: this.settings.assemblyAiSpeechModel,
			transcriptionLanguage: this.settings.transcriptionLanguage,
		});

		this.recordingManager.onRecordingSaved((session, recordingPath) => {
			void this.linkRecordingToNote(session, recordingPath);

			if (this.settings.autoTranscribe && this.settings.assemblyAiApiKey) {
				void this.transcriptionManager.transcribe({
					recordingPath,
					session: {eventId: session.eventId, subject: session.subject, date: session.date},
				});
			}
		});

		this.transcriptionManager.onTranscriptionSaved((request, transcriptPath) => {
			void this.linkTranscriptToNote(request.session, transcriptPath);
		});

		this.registerView(VIEW_TYPE_CALENDAR, (leaf) =>
			new CalendarView(leaf, this.settings, this.provider, this.recordingManager)
		);

		registerRecordingCodeBlock(this);

		const statusBarEl = this.addStatusBarItem();
		this.statusBarRecording = new StatusBarRecording(statusBarEl, this.recordingManager, this.transcriptionManager);

		this.noteRecordingAction = new NoteRecordingAction(this.app, this.recordingManager);
		this.noteTranscriptionAction = new NoteTranscriptionAction(this.app, this.transcriptionManager, this.recordingManager);

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

		this.addSettingTab(new WhisperCalSettingTab(this.app, this));
	}

	onunload() {
		this.noteTranscriptionAction?.destroy();
		this.noteRecordingAction?.destroy();
		this.statusBarRecording?.destroy();
		this.auth.cancelSignIn();
		this.transcriptionManager.dispose();
		this.recordingManager.dispose();
	}

	async loadSettings() {
		const data = await this.loadData() as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// tokenCache is stored in data but not part of WhisperCalSettings
		// It gets loaded separately by loadTokenCache()
	}

	async saveSettings() {
		// Persist settings (tokenCache is saved alongside)
		const data = await this.loadData() as Partial<PluginData> | null;
		await this.saveData({...data, ...this.settings});
		// Update auth config if tenant/client/cloud changed
		this.auth.updateConfig({
			tenantId: this.settings.tenantId,
			clientId: this.settings.clientId,
			cloudInstance: this.settings.cloudInstance,
		});
		// Update recording manager config
		this.recordingManager.updateConfig({
			recordingFolderPath: this.settings.recordingFolderPath,
			systemAudioDeviceId: this.settings.systemAudioDeviceId,
		});
		// Update transcription manager config
		this.transcriptionManager.updateConfig({
			transcriptionFolderPath: this.settings.transcriptionFolderPath,
			assemblyAiBaseUrl: this.settings.assemblyAiBaseUrl,
			assemblyAiApiKey: this.settings.assemblyAiApiKey,
			assemblyAiSpeechModel: this.settings.assemblyAiSpeechModel,
			transcriptionLanguage: this.settings.transcriptionLanguage,
		});
		// Update existing views with new settings
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) {
				view.updateSettings(this.settings, this.provider, this.recordingManager);
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
		// Synchronously read from the already-loaded data
		// loadData() was called in loadSettings() before auth.initialize()
		// tokenCache lives in data.json alongside settings fields
		return (this.settings as unknown as Record<string, unknown>)?.["tokenCache"] as TokenCache | null ?? null;
	}

	private async saveTokenCache(cache: TokenCache | null): Promise<void> {
		const data = await this.loadData() as Partial<PluginData> | null;
		await this.saveData({...data, ...this.settings, tokenCache: cache});
	}

	private async linkRecordingToNote(
		session: {date: string; subject: string},
		recordingPath: string,
	): Promise<void> {
		const filename = this.settings.noteFilenameTemplate
			.replace("{{date}}", session.date)
			.replace("{{subject}}", sanitizeFilename(session.subject));
		const notePath = `${this.settings.noteFolderPath}/${filename}.md`;

		if (!this.app.vault.getAbstractFileByPath(notePath)) return;

		const recordingFilename = recordingPath.split("/").pop() ?? recordingPath;
		await updateFrontmatter(this.app, notePath, "recording", `[[${recordingFilename}]]`);
	}

	private async linkTranscriptToNote(
		session: {date: string; subject: string},
		transcriptPath: string,
	): Promise<void> {
		const filename = this.settings.noteFilenameTemplate
			.replace("{{date}}", session.date)
			.replace("{{subject}}", sanitizeFilename(session.subject));
		const notePath = `${this.settings.noteFolderPath}/${filename}.md`;

		if (!this.app.vault.getAbstractFileByPath(notePath)) return;

		// Link without extension for markdown files
		const transcriptFilename = transcriptPath.split("/").pop() ?? transcriptPath;
		const nameWithoutExt = transcriptFilename.replace(/\.md$/, "");
		await updateFrontmatter(this.app, notePath, "transcript", `[[${nameWithoutExt}]]`);
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
