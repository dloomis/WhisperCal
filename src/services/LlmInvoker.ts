import {spawn, execSync, type ChildProcess} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface LlmInvokerOpts {
	targetPath: string;       // vault-relative path to the file the prompt operates on
	targetLabel?: string;     // label for the target in the trigger string (default: "Transcript")
	vaultPath: string;        // absolute path to vault root
	promptPath: string;       // absolute or vault-relative path to the prompt file
	llmCli: string;
	llmExtraFlags: string;
	timeoutMs?: number;       // kill the process after this many ms (0 = no timeout)
	// Optional parameters that skip prompt steps when provided
	microphoneUser?: string;
	transcriptFolderPath?: string;  // folder name for transcript files
	peopleFolderPath?: string;      // folder name for People notes
	batch?: boolean;                // when true, appends "batch: true." to trigger
	debugMode?: boolean;            // when true, opens in Terminal.app instead of background
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
 * Build the shell command string and resolved trigger from LlmInvokerOpts.
 */
function buildLlmCommand(opts: LlmInvokerOpts): {cmd: string; vaultPath: string} {
	const resolvedPromptPath = resolvePromptPath(opts.promptPath, opts.vaultPath);

	// Build trigger string
	const parts: string[] = [
		`Follow the instructions in '${resolvedPromptPath}'.`,
		`${opts.targetLabel || "Transcript"}: ${opts.targetPath}.`,
	];
	if (opts.microphoneUser) parts.push(`Microphone user: ${opts.microphoneUser}.`);
	if (opts.transcriptFolderPath) parts.push(`Transcripts Folder: ${opts.transcriptFolderPath}.`);
	if (opts.peopleFolderPath) parts.push(`People Folder: ${opts.peopleFolderPath}.`);
	if (opts.batch) parts.push("batch: true.");
	const trigger = parts.join(" ");

	const flags = [opts.llmExtraFlags.trim()].filter(Boolean).join(" ");
	const cmd = `${opts.llmCli}${flags ? " " + flags : ""} ${shellQuote(trigger)}`;
	return {cmd, vaultPath: opts.vaultPath};
}

/**
 * Spawn the LLM CLI as a background child process (no terminal window).
 * Returns the exit code and any stderr output when the process finishes.
 */
export function spawnLlmPrompt(opts: LlmInvokerOpts): Promise<{exitCode: number; stdout: string; stderr: string}> {
	if (opts.debugMode) {
		return spawnLlmPromptTerminal(opts);
	}

	const {cmd, vaultPath} = buildLlmCommand(opts);
	const timeoutMs = opts.timeoutMs ?? 0;

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

/**
 * Open the LLM CLI in a Terminal.app window for debugging.
 * Output is tee'd to temp files so callers still get stdout/stderr/exitCode.
 */
function spawnLlmPromptTerminal(opts: LlmInvokerOpts): Promise<{exitCode: number; stdout: string; stderr: string}> {
	const {cmd, vaultPath} = buildLlmCommand(opts);
	const timeoutMs = opts.timeoutMs ?? 0;

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "whispercal-llm-"));
	const stdoutFile = path.join(tmpDir, "stdout");
	const stderrFile = path.join(tmpDir, "stderr");
	const exitCodeFile = path.join(tmpDir, "exitcode");
	const scriptFile = path.join(tmpDir, "run.sh");

	// Build a wrapper script that captures output and exit code.
	// Use the user's shell as a login shell so PATH (Homebrew, etc.) is available.
	const userShell = os.userInfo().shell || "/bin/zsh";
	const scriptLines = [
		`#!${userShell} -l`,
		`cd ${shellQuote(vaultPath)}`,
		`echo "━━━ WhisperCal LLM Debug ━━━"`,
		`echo "Command: ${escapeSq(cmd)}"`,
		`echo "Working dir: ${escapeSq(vaultPath)}"`,
		`echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"`,
		`echo ""`,
		// Run the command; tee stdout to file, capture stderr via fd 3
		`exec 3>&1`,
		`{ ${cmd} 2>&1 1>&3 3>&- | tee ${shellQuote(stderrFile)} >&2 3>&-; } 3>&1 1>&2 | tee ${shellQuote(stdoutFile)}`,
		// Capture exit code from PIPESTATUS (the LLM command, not tee)
		`echo \${PIPESTATUS[0]} > ${shellQuote(exitCodeFile)}`,
		`echo ""`,
		`echo "━━━ Process exited with code $(cat ${shellQuote(exitCodeFile)}) ━━━"`,
	];

	fs.writeFileSync(scriptFile, scriptLines.join("\n"), {mode: 0o755});

	// Open Terminal.app with the script.
	// AppleScript strings use double quotes; escape any in the path.
	const asQuoted = `"${scriptFile.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	const osascript = [
		`tell application "Terminal"`,
		`  do script ${asQuoted}`,
		`  activate`,
		`end tell`,
	].join("\n");

	try {
		execSync(`osascript -e ${shellQuote(osascript)}`);
	} catch (err) {
		// Clean up temp dir on failure
		fs.rmSync(tmpDir, {recursive: true, force: true});
		const msg = err instanceof Error ? err.message : String(err);
		return Promise.resolve({exitCode: 1, stdout: "", stderr: `Failed to open Terminal: ${msg}`});
	}

	// Poll for the exit code file to appear
	return new Promise((resolve) => {
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
			}, timeoutMs);
		}

		const pollInterval = setInterval(() => {
			if (timedOut) {
				clearInterval(pollInterval);
				if (timer) clearTimeout(timer);
				const mins = Math.round(timeoutMs / 60000);
				resolve({
					exitCode: 1,
					stdout: readFileOrEmpty(stdoutFile),
					stderr: `LLM process timed out after ${mins} minute${mins !== 1 ? "s" : ""}`,
				});
				cleanupTmpDir(tmpDir);
				return;
			}

			if (!fs.existsSync(exitCodeFile)) return;

			clearInterval(pollInterval);
			if (timer) clearTimeout(timer);

			// Small delay to let tee finish flushing
			setTimeout(() => {
				const exitCode = parseInt(readFileOrEmpty(exitCodeFile).trim(), 10) || 1;
				const stdout = readFileOrEmpty(stdoutFile);
				const stderr = readFileOrEmpty(stderrFile);
				resolve({exitCode, stdout, stderr});
				cleanupTmpDir(tmpDir);
			}, 500);
		}, 1000);
	});
}

function readFileOrEmpty(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

function cleanupTmpDir(tmpDir: string): void {
	try {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	} catch {
		// Best-effort cleanup
	}
}
