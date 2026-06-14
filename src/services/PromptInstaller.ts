import {App, normalizePath} from "obsidian";
import postProcessingPrompt from "../../prompts/Transcript Post-Processing Prompt.md";
import summarizerPrompt from "../../prompts/Meeting Transcript Summarizer Prompt.md";
import researchPrompt from "../../prompts/Meeting Research Prompt.md";

interface PromptEntry {
	settingPath: string;
	content: string;
}

// The old "Speaker Auto-Tag" prompt is intentionally not installed: the default is now the
// in-place post-processing prompt, and the #4 settings migration repoints prior installs.
// The repo still keeps the file for anyone who deliberately wants the name-only behavior.
const BUNDLED_PROMPTS: PromptEntry[] = [
	{settingPath: "Prompts/Transcript Post-Processing Prompt.md", content: postProcessingPrompt},
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
