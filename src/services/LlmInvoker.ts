import {spawn, type ChildProcess} from "child_process";
import * as os from "os";
import * as path from "path";

export interface LlmInvokerOpts {
	targetPath: string;       // vault-relative path to the file the prompt operates on
	targetLabel?: string;     // label for the target in the trigger string (default: "Transcript")
	vaultPath: string;        // absolute path to vault root
	promptPath: string;       // absolute or vault-relative path to the prompt file
	llmCli: string;
	llmSkipPermissions: boolean;
	llmExtraFlags: string;
	timeoutMs?: number;       // kill the process after this many ms (0 = no timeout)
	// Optional parameters that skip prompt steps when provided
	microphoneUser?: string;
	transcriptFolderPath?: string;  // folder name for transcript files
	peopleFolderPath?: string;      // folder name for People notes
	batch?: boolean;                // when true, appends "batch: true." to trigger
}

/** Active child processes tracked for cleanup on plugin unload. */
export const activeProcesses = new Set<ChildProcess>();

// Escape a string for use in a single-quoted shell argument: replace ' with '\''
function escapeSq(s: string): string {
	return s.replace(/'/g, "'\\''");
}

// Wrap a shell argument in single quotes (with internal escaping)
function shellQuote(s: string): string {
	return `'${escapeSq(s)}'`;
}

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Check whether the LLM CLI is available on the user's PATH.
 * Returns true if found, false otherwise.
 */
export async function validateLlmCli(cliPath: string): Promise<boolean> {
	const userShell = os.userInfo().shell || "/bin/zsh";
	return new Promise((resolve) => {
		// Use login shell so the user's PATH (Homebrew etc.) is available
		const child = spawn(userShell, ["-l", "-c", `command -v ${shellQuote(cliPath)}`], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}

/**
 * Resolve a prompt path (absolute, ~/relative, or vault-relative) to an absolute path.
 */
export function resolvePromptPath(promptPath: string, vaultPath: string): string {
	if (promptPath.startsWith("/")) return promptPath;
	if (promptPath.startsWith("~/")) return path.join(os.homedir(), promptPath.slice(2));
	return path.join(vaultPath, promptPath);
}

/**
 * Spawn the LLM CLI as a background child process (no terminal window).
 * Returns the exit code and any stderr output when the process finishes.
 */
export function spawnLlmPrompt(opts: LlmInvokerOpts): Promise<{exitCode: number; stdout: string; stderr: string}> {
	const {
		targetPath,
		targetLabel = "Transcript",
		vaultPath,
		promptPath,
		microphoneUser,
		llmCli,
		llmSkipPermissions,
		llmExtraFlags,
		transcriptFolderPath,
		peopleFolderPath,
		batch,
		timeoutMs = 0,
	} = opts;

	const resolvedPromptPath = resolvePromptPath(promptPath, vaultPath);

	// Build trigger string
	const parts: string[] = [
		`Follow the instructions in '${resolvedPromptPath}'.`,
		`${targetLabel}: ${targetPath}.`,
	];
	if (microphoneUser) parts.push(`Microphone user: ${microphoneUser}.`);
	if (transcriptFolderPath) parts.push(`Transcripts Folder: ${transcriptFolderPath}.`);
	if (peopleFolderPath) parts.push(`People Folder: ${peopleFolderPath}.`);
	if (batch) parts.push("batch: true.");
	const trigger = parts.join(" ");

	// Build CLI flags and full shell command
	const flags = [
		llmSkipPermissions ? "--dangerously-skip-permissions" : "",
		llmExtraFlags.trim(),
	].filter(Boolean).join(" ");
	const cmd = `${llmCli}${flags ? " " + flags : ""} ${shellQuote(trigger)}`;

	// Use a login shell so the user's PATH (e.g. Homebrew) is available.
	const userShell = os.userInfo().shell || "/bin/zsh";

	return new Promise((resolve) => {
		const child = spawn(userShell, ["-l", "-c", cmd], {
			cwd: vaultPath,
			stdio: ["ignore", "pipe", "pipe"],
		});

		activeProcesses.add(child);

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];

		child.stdout.on("data", (data: {toString(): string}) => {
			const text = data.toString();
			stdoutChunks.push(text);
			console.debug("[WhisperCal] LLM stdout:", text);
		});

		child.stderr.on("data", (data: {toString(): string}) => {
			const text = data.toString();
			stderrChunks.push(text);
			console.error("[WhisperCal] LLM stderr:", text);
		});

		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				// Force-kill after 5 seconds if SIGTERM doesn't work
				setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 5000);
			}, timeoutMs);
		}

		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			activeProcesses.delete(child);
			console.error("[WhisperCal] LLM spawn error:", err);
			resolve({exitCode: 1, stdout: "", stderr: err.message});
		});

		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			activeProcesses.delete(child);
			if (timedOut) {
				const mins = Math.round(timeoutMs / 60000);
				resolve({exitCode: 1, stdout: stdoutChunks.join(""), stderr: `LLM process timed out after ${mins} minute${mins !== 1 ? "s" : ""}`});
			} else {
				resolve({exitCode: code ?? 1, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("")});
			}
		});
	});
}
