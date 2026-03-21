import {execFile, spawn, type ChildProcess} from "child_process";
import {writeFile} from "fs/promises";
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
	terminalApp: "Terminal" | "iTerm2";
	autoCloseTerminal: boolean;
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

// Embed s as an AppleScript string literal, handling embedded double quotes
// via AppleScript's string concatenation with the `quote` variable.
function asAppleScriptStr(s: string): string {
	const parts = s.split('"');
	if (parts.length === 1) return `"${s}"`;
	return parts.map(p => `"${p}"`).join(' & quote & ');
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

export async function invokeLlmPrompt(opts: LlmInvokerOpts): Promise<void> {
	const {
		targetPath,
		targetLabel = "Transcript",
		vaultPath,
		promptPath,
		microphoneUser,
		llmCli,
		llmSkipPermissions,
		llmExtraFlags,
		terminalApp,
		autoCloseTerminal,
		transcriptFolderPath,
		peopleFolderPath,
	} = opts;

	const resolvedPromptPath = resolvePromptPath(promptPath, vaultPath);

	// Build trigger string with required and optional parameters
	const parts: string[] = [
		`Follow the instructions in '${resolvedPromptPath}'.`,
		`${targetLabel}: ${targetPath}.`,
	];
	if (microphoneUser) parts.push(`Microphone user: ${microphoneUser}.`);
	if (transcriptFolderPath) parts.push(`Transcripts Folder: ${transcriptFolderPath}.`);
	if (peopleFolderPath) parts.push(`People Folder: ${peopleFolderPath}.`);
	const trigger = parts.join(" ");

	// Build CLI flags and command
	const flags = [
		llmSkipPermissions ? "--dangerously-skip-permissions" : "",
		llmExtraFlags.trim(),
	].filter(Boolean).join(" ");
	const cmd = `${llmCli}${flags ? " " + flags : ""} ${shellQuote(trigger)}`;
	const shellCmd = `cd ${shellQuote(vaultPath)} && ${cmd}`;

	// Write shellCmd to a temp script to avoid shell-quoting/AppleScript quoting conflicts.
	// (Shell's '\'' escaping inside AppleScript double-quoted strings causes a syntax error.)
	const tmpScript = path.join(os.tmpdir(), `whisper-cal-${Date.now()}.sh`);
	// When auto-close is on, exit the shell after the CLI finishes so the terminal can close.
	const scriptBody = autoCloseTerminal
		? `#!/bin/bash\n${shellCmd}\nexit 0\n`
		: `#!/bin/bash\n${shellCmd}\n`;
	await writeFile(tmpScript, scriptBody, {mode: 0o755});

	// The temp path has no special characters, so embedding it in AppleScript is safe.
	// Use exec so bash replaces the login shell — when the script exits,
	// Terminal.app sees the tab as "not busy" and the close logic works.
	const runPrefix = autoCloseTerminal ? "exec " : "";
	const asCmd = asAppleScriptStr(`${runPrefix}bash ${shellQuote(tmpScript)}`);
	let applescript: string;
	if (terminalApp === "iTerm2") {
		// iTerm2: the script already has `exit 0` when auto-close is on,
		// which ends the session. iTerm2's default "close if clean exit"
		// profile setting handles window cleanup automatically.
		applescript = `tell application "iTerm2"
	create window with default profile
	tell current session of current window
		write text ${asCmd}
	end tell
	delay 0.5
	activate
end tell`;
	} else {
		if (autoCloseTerminal) {
			// Terminal.app: run the command, then close the specific window when done.
			// "do script" returns a tab reference; its `window` property tracks the window.
			applescript = `tell application "Terminal"
	set newTab to do script ${asCmd}
	set targetWindow to window of newTab
	delay 0.5
	activate
	repeat
		delay 2
		if not busy of newTab then exit repeat
	end repeat
	close targetWindow
end tell`;
		} else {
			applescript = `tell application "Terminal"
	do script ${asCmd}
	delay 0.5
	activate
end tell`;
		}
	}

	execFile("osascript", ["-e", applescript], (err) => {
		if (err) console.error("[WhisperCal] LlmInvoker osascript error:", err);
	});
}
