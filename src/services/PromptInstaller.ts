import {App, normalizePath} from "obsidian";
import speakerTagPrompt from "../../prompts/Speaker Auto-Tag Prompt.md";
import summarizerPrompt from "../../prompts/Meeting Transcript Summarizer Prompt.md";
import researchPrompt from "../../prompts/Meeting Research Prompt.md";

interface PromptEntry {
	settingPath: string;
	content: string;
}

const BUNDLED_PROMPTS: PromptEntry[] = [
	{settingPath: "Prompts/Speaker Auto-Tag Prompt.md", content: speakerTagPrompt},
	{settingPath: "Prompts/Meeting Transcript Summarizer Prompt.md", content: summarizerPrompt},
	{settingPath: "Prompts/Meeting Research Prompt.md", content: researchPrompt},
];

/**
 * Write bundled prompt files into the vault if they don't already exist.
 * Called once during plugin onload().
 */
export async function installBundledPrompts(app: App): Promise<void> {
	for (const prompt of BUNDLED_PROMPTS) {
		const path = normalizePath(prompt.settingPath);
		if (app.vault.getAbstractFileByPath(path)) continue;

		// Ensure parent folder exists
		const folder = path.substring(0, path.lastIndexOf("/"));
		if (folder && !app.vault.getAbstractFileByPath(folder)) {
			await app.vault.createFolder(folder);
		}

		await app.vault.create(path, prompt.content);
		console.debug(`WhisperCal: installed bundled prompt → ${path}`);
	}
}
