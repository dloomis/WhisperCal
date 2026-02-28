import {Plugin, WorkspaceLeaf} from "obsidian";
import {DEFAULT_SETTINGS, WhisperCalSettings, WhisperCalSettingTab} from "./settings";
import {VIEW_TYPE_CALENDAR, COMMAND_OPEN_CALENDAR} from "./constants";
import {CalendarView} from "./ui/CalendarView";
import {createCalendarProvider} from "./services/CalendarProvider";
import type {CalendarProvider} from "./types";

export default class WhisperCalPlugin extends Plugin {
	settings: WhisperCalSettings;
	private provider: CalendarProvider;

	async onload() {
		await this.loadSettings();
		this.provider = createCalendarProvider(this.settings.m365CliPath);

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
		// View cleanup is handled by Obsidian when detaching leaves
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<WhisperCalSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Update provider if CLI path changed
		this.provider = createCalendarProvider(this.settings.m365CliPath);
		// Update existing views with new settings
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			const view = leaf.view;
			if (view instanceof CalendarView) {
				view.updateSettings(this.settings, this.provider);
			}
		}
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
