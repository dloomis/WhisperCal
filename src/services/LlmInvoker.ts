import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {runLlm} from "./LlmTransport";

/**
 * LLM invocation orchestration (DESIGN C5): everything WhisperCal-specific about
 * an LLM run — the prompt-file / inline-prompt precedence, trigger assembly
 * (transcript path, folders, roster, voiceprint anchors, …), and the plugin tmp
 * dir — assembled into a generic transport request. All process mechanics
 * (spawn, kills, quoting, timeouts, concurrency slots) live in `LlmTransport`,
 * which stays product-blind; nothing prompt- or meeting-aware may sink below it.
 *
 * The generic helpers are re-exported so existing call sites keep importing them
 * from here; new code should import them from `LlmTransport` directly.
 */
export {
	activeProcesses,
	killProcessTree,
	stripAnsi,
	cleanLlmStderr,
	validateLlmCli,
	activeLlmCount,
	claimLlmSlot,
	releaseLlmSlot,
} from "./LlmTransport";

interface LlmInvokerOpts {
	targetPath: string;       // vault-relative path to the file the prompt operates on
	targetLabel?: string;     // label for the target in the trigger string (default: "Transcript")
	vaultPath: string;        // absolute path to vault root
	pluginDir: string;        // vault-relative plugin dir (e.g. ".obsidian/plugins/whisper-cal"); from manifest.dir
	promptPath?: string;      // absolute or vault-relative path to the prompt file (omit when using inlinePrompt)
	inlinePrompt?: string;    // direct prompt text — replaces the prompt file reference when set
	llmCli: string;
	llmExtraFlags: string;
	llmPromptFlags?: string;  // per-prompt flags appended after llmExtraFlags (e.g. "--effort medium")
	llmModel?: string;        // model ID to pass via --model flag (empty = CLI default)
	timeoutMs?: number;       // kill the process after this many ms (0 = no timeout)
	// Optional parameters that skip prompt steps when provided
	microphoneUser?: string;
	transcriptFolderPath?: string;  // folder name for transcript files
	peopleFolderPath?: string;      // folder name for People notes
	outputFormat?: string;          // appended to trigger to specify expected output format
	calendarAttendees?: string;     // full invitee name list — skips prompt Step 4/5
	peopleRoster?: string;          // pre-built enriched Markdown table — skips prompt Step 3/6
	voiceprintMatches?: string;     // label→name pairs already confirmed acoustically; prompt treats them as fixed CERTAIN and only identifies the rest
	researchNotePaths?: string[];   // vault-relative paths to research context notes
	additionalInstructions?: string; // free-text instructions appended to trigger
	debugMode?: boolean;            // when true, opens in Terminal.app instead of background
	debugLogging?: boolean;         // when true, logs LLM command/trigger/stdout to developer console
}

/**
 * Resolve a prompt path (absolute, ~/relative, or vault-relative) to an absolute path.
 */
export function resolvePromptPath(promptPath: string, vaultPath: string): string {
	if (path.isAbsolute(promptPath)) return promptPath;
	// Accept both separators after ~ so Windows-style `~\path` also expands.
	if (promptPath.startsWith("~/") || promptPath.startsWith("~\\")) return path.join(os.homedir(), promptPath.slice(2));
	return path.join(vaultPath, promptPath);
}

/**
 * Build the trigger string (prompt) from LlmInvokerOpts.
 * When promptInSystem is true, the prompt content is delivered separately by the
 * transport (system prefix on POSIX, prepended to the user message on Windows),
 * so omit the file reference.
 */
function buildTrigger(opts: LlmInvokerOpts, promptInSystem: boolean): string {
	const parts: string[] = [];
	if (promptInSystem) {
		// Static instructions travel via the transport — omit from the trigger.
	} else if (opts.promptPath) {
		// Use the original path (vault-relative or user-configured) rather than
		// resolving to absolute — avoids leaking filesystem paths to the LLM.
		// The CLI runs with cwd=vaultPath so vault-relative paths resolve correctly.
		parts.push(`Follow the instructions in '${opts.promptPath}'.`);
	}
	parts.push(`${opts.targetLabel || "Transcript"}: ${opts.targetPath}.`);
	if (opts.microphoneUser) parts.push(`Microphone user: ${opts.microphoneUser}.`);
	if (opts.transcriptFolderPath) parts.push(`Transcripts Folder: ${opts.transcriptFolderPath}.`);
	if (opts.peopleFolderPath) parts.push(`People Folder: ${opts.peopleFolderPath}.`);
	if (opts.calendarAttendees) parts.push(`Calendar Attendees: ${opts.calendarAttendees}.`);
	if (opts.peopleRoster) parts.push(`People Roster:\n${opts.peopleRoster}`);
	if (opts.voiceprintMatches) parts.push(`Voiceprint Matches: ${opts.voiceprintMatches}.`);
	if (opts.researchNotePaths && opts.researchNotePaths.length > 0) parts.push(`Research notes: ${opts.researchNotePaths.join(", ")}.`);
	if (opts.additionalInstructions) parts.push(`Additional instructions: ${opts.additionalInstructions}`);
	if (opts.outputFormat) parts.push(opts.outputFormat);
	return parts.join(" ");
}

/**
 * Run an LLM prompt described by LlmInvokerOpts through the generic transport.
 * Returns the exit code and any output when the process finishes (fire-and-forget
 * when debugMode opens a terminal instead).
 *
 * Static instructions (prompt file or inline prompt; inlinePrompt wins when both
 * are set — bypass mode) are read here and handed to the transport as
 * `systemPrompt`, which owns the per-platform delivery mechanics (system-prefix
 * injection for prompt caching + instruction authority on POSIX; user-message
 * prepend on Windows). If the prompt file can't be read (missing, permissions),
 * fall back to referencing it in the trigger — the CLI reads it itself.
 */
export function spawnLlmPrompt(opts: LlmInvokerOpts): Promise<{exitCode: number; stdout: string; stderr: string}> {
	let systemPrompt: string | undefined;
	if (opts.inlinePrompt) {
		systemPrompt = opts.inlinePrompt;
	} else if (opts.promptPath) {
		try {
			systemPrompt = fs.readFileSync(resolvePromptPath(opts.promptPath, opts.vaultPath), "utf-8");
		} catch {
			// Prompt file unreadable — buildTrigger keeps the file reference.
		}
	}
	const trigger = buildTrigger(opts, systemPrompt !== undefined);

	return runLlm({
		systemPrompt,
		userMessage: trigger,
		cli: opts.llmCli,
		extraFlags: opts.llmExtraFlags,
		promptFlags: opts.llmPromptFlags,
		model: opts.llmModel,
		cwd: opts.vaultPath,
		tmpDir: path.join(opts.vaultPath, opts.pluginDir, "tmp"),
		timeoutMs: opts.timeoutMs,
		debugMode: opts.debugMode,
		debugLogging: opts.debugLogging,
	});
}
