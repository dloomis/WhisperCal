import {Plugin, WorkspaceLeaf} from "obsidian";
import {DEFAULT_SETTINGS, WhisperCalSettings, WhisperCalSettingTab} from "./settings";
import {VIEW_TYPE_CALENDAR, COMMAND_OPEN_CALENDAR} from "./constants";
import {CalendarView} from "./ui/CalendarView";
import {createCalendarProvider} from "./services/CalendarProvider";
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

		this.addSettingTab(new WhisperCalSettingTab(this.app, this));
	}

	onunload() {
		this.auth.cancelSignIn();
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
		// Synchronously read from the already-loaded data
		// loadData() was called in loadSettings() before auth.initialize()
		// tokenCache lives in data.json alongside settings fields
		return (this.settings as unknown as Record<string, unknown>)?.["tokenCache"] as TokenCache | null ?? null;
	}

	private async saveTokenCache(cache: TokenCache | null): Promise<void> {
		const data = await this.loadData() as Partial<PluginData> | null;
		await this.saveData({...data, ...this.settings, tokenCache: cache});
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
