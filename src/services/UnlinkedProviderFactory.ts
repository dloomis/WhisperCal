import type {App} from "obsidian";
import type {WhisperCalSettings} from "../settings";
import type {UnlinkedRecordingProvider} from "./UnlinkedRecordingProvider";
import {MacWhisperUnlinkedProvider} from "./MacWhisperUnlinkedProvider";
import {ApiUnlinkedProvider} from "./ApiUnlinkedProvider";

export function createUnlinkedProvider(
	settings: WhisperCalSettings,
	app: App,
): UnlinkedRecordingProvider {
	switch (settings.recordingSource) {
	case "macwhisper":
		return new MacWhisperUnlinkedProvider(app);
	case "api":
		return new ApiUnlinkedProvider(app, settings);
	}
}
