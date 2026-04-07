import {spawn, execFile, type ChildProcess} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {Platform} from "obsidian";

interface LlmInvokerOpts {
	targetPath: string;       // vault-relative path to the file the prompt operates on
	targetLabel?: string;     // label for the target in the trigger string (default: "Transcript")
	vaultPath: string;        // absolute path to vault root
	promptPath?: string;      // absolute or vault-relative path to the prompt file (omit when using inlinePrompt)
	inlinePrompt?: string;    // direct prompt text — replaces the prompt file reference when set
	llmCli: string;
	llmExtraFlags: string;
	llmModel?: string;        // model ID to pass via --model flag (empty = CLI default)
	timeoutMs?: number;       // kill the process after this many ms (0 = no timeout)
	// Optional parameters that skip prompt steps when provided
	microphoneUser?: string;
	transcriptFolderPath?: string;  // folder name for transcript files
	peopleFolderPath?: string;      // folder name for People notes
	outputFormat?: string;          // appended to trigger to specify expected output format
	calendarAttendees?: string;     // full invitee name list — skips prompt Step 4/5
	peopleRoster?: string;          // pre-built enriched Markdown table — skips prompt Step 3/6
	researchNotePaths?: string[];   // vault-relative paths to research context notes
	additionalInstructions?: string; // free-text instructions appended to trigger
	debugMode?: boolean;            // when true, opens in Terminal.app instead of background
}

/**
 * If llmExtraFlags references a --mcp-config file, ensure it exists.
 * Recreate with an empty config if missing (e.g. after reboot).
 */
function ensureMcpConfigFile(flags: string): void {
	const match = /--mcp-config\s+(\S+)/.exec(flags);
	if (!match) return;
	const configPath = match[1]!;
	if (!fs.existsSync(configPath)) {
		try {
			fs.writeFileSync(configPath, '{"mcpServers": {}}\n', "utf-8");
		} catch { /* best-effort */ }
	}
}

/**
 * Return a plugin-local temp directory inside the vault.
 * Using the vault avoids OS-specific temp paths and works cross-platform.
 */
function getPluginTmpDir(vaultPath: string): string {
	const dir = path.join(vaultPath, ".obsidian", "plugins", "whisper-cal", "tmp");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
	return dir;
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

/** Quote a shell argument for the current platform. */
function platformQuote(s: string): string {
	if (Platform.isWin) {
		// cmd.exe: wrap in double quotes, escape internal double quotes
		return `"${s.replace(/"/g, '""')}"`;
	}
	return shellQuote(s);
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
	if (Platform.isWin) {
		return new Promise((resolve) => {
			const child = spawn("where.exe", [cliPath], {
				stdio: ["ignore", "ignore", "ignore"],
			});
			child.on("error", () => resolve(false));
			child.on("close", (code) => resolve(code === 0));
		});
	}
	const userShell = os.userInfo().shell || "/bin/zsh";
	return new Promise((resolve) => {
		// Use interactive login shell so PATH set in .zshrc/.bashrc is available
		const child = spawn(userShell, ["-li", "-c", `command -v ${shellQuote(cliPath)}`], {
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
	if (path.isAbsolute(promptPath)) return promptPath;
	if (promptPath.startsWith("~/")) return path.join(os.homedir(), promptPath.slice(2));
	return path.join(vaultPath, promptPath);
}

/**
 * Build the trigger string (prompt) from LlmInvokerOpts.
 * When promptInSystem is true, the prompt file content has been injected into
 * the system message via --append-system-prompt, so omit the file reference.
 */
function buildTrigger(opts: LlmInvokerOpts, promptInSystem = false): string {
	const parts: string[] = [];
	if (opts.inlinePrompt) {
		parts.push(opts.inlinePrompt);
	} else if (opts.promptPath && !promptInSystem) {
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
	if (opts.researchNotePaths && opts.researchNotePaths.length > 0) parts.push(`Research notes: ${opts.researchNotePaths.join(", ")}.`);
	if (opts.additionalInstructions) parts.push(`Additional instructions: ${opts.additionalInstructions}`);
	if (opts.outputFormat) parts.push(opts.outputFormat);
	return parts.join(" ");
}

/**
 * Build the CLI + flags portion of the shell command (without the trigger).
 * When systemPromptFile is set, adds --append-system-prompt to inject static
 * prompt instructions into the system message for prompt cache optimization.
 */
function buildCliCommand(opts: LlmInvokerOpts, systemPromptFile?: string): string {
	const flagParts: string[] = [];
	// Print mode: process one prompt via stdin and exit (no interactive TUI).
	flagParts.push("-p");
	// Skip loading user skills — they inflate the system prompt with irrelevant context.
	flagParts.push("--disable-slash-commands");
	// Don't persist session data to disk — these are ephemeral worker runs.
	flagParts.push("--no-session-persistence");
	// Inject static prompt instructions into the system message so they land in
	// the cacheable prefix (tools → system → messages). Without this, the LLM
	// reads the prompt via a tool call, placing instructions after the variable
	// user message — which changes the prefix hash and prevents cache hits.
	// $(cat file) inside double quotes is safe: the shell does not re-expand the result.
	if (systemPromptFile) {
		flagParts.push(`--append-system-prompt "$(cat ${shellQuote(systemPromptFile)})"`);
	}
	if (opts.llmModel) flagParts.push(`--model ${platformQuote(opts.llmModel)}`);
	if (opts.llmExtraFlags.trim()) {
		// Split extra flags on whitespace and quote each individually to prevent injection
		for (const flag of opts.llmExtraFlags.trim().split(/\s+/)) {
			flagParts.push(platformQuote(flag));
		}
	}
	const flags = flagParts.join(" ");
	return `${platformQuote(opts.llmCli)}${flags ? " " + flags : ""}`;
}

/**
 * Build the full shell command string from LlmInvokerOpts.
 * Pipes the trigger via stdin to avoid OS argument length limits.
 *
 * Prompt cache optimization (macOS/Linux only): when a prompt file is set,
 * reads it into a temp file and passes the content via --append-system-prompt.
 * This places static instructions in the system prefix where they're cached
 * by the API, keeping only variable parameters in the user message.
 * Falls back to the original "Follow the instructions in..." trigger if the
 * prompt file can't be read (e.g. missing or permissions).
 */
function buildLlmCommand(opts: LlmInvokerOpts): {cmd: string; trigger: string; vaultPath: string; tmpFiles: string[]} {
	const tmpFiles: string[] = [];
	let systemPromptFile: string | undefined;

	if (opts.promptPath && !opts.inlinePrompt && !Platform.isWin) {
		const resolved = resolvePromptPath(opts.promptPath, opts.vaultPath);
		try {
			const content = fs.readFileSync(resolved, "utf-8");
			const tmpFile = path.join(getPluginTmpDir(opts.vaultPath), `wcal-sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
			fs.writeFileSync(tmpFile, content, "utf-8");
			tmpFiles.push(tmpFile);
			systemPromptFile = tmpFile;
		} catch {
			// Prompt file unreadable — fall back to old behavior (LLM reads the file itself).
		}
	}

	const trigger = buildTrigger(opts, !!systemPromptFile);
	const cli = buildCliCommand(opts, systemPromptFile);
	// Pipe trigger via stdin using a heredoc to avoid ENAMETOOLONG on long prompts.
	const cmd = `${cli} <<'__WCAL_EOF__'\n${trigger}\n__WCAL_EOF__`;
	return {cmd, trigger, vaultPath: opts.vaultPath, tmpFiles};
}

/**
 * Spawn the LLM CLI as a background child process (no terminal window).
 * Returns the exit code and any stderr output when the process finishes.
 */
export function spawnLlmPrompt(opts: LlmInvokerOpts): Promise<{exitCode: number; stdout: string; stderr: string}> {
	// Ensure any --mcp-config file referenced in flags exists (may be missing after reboot).
	ensureMcpConfigFile(opts.llmExtraFlags);

	if (opts.debugMode) {
		return spawnLlmPromptTerminal(opts);
	}

	const {cmd, trigger, vaultPath, tmpFiles} = buildLlmCommand(opts);
	const timeoutMs = opts.timeoutMs ?? 0;
	console.debug("[WhisperCal] LLM command:", cmd);
	console.debug("[WhisperCal] LLM trigger:", trigger);

	const cleanupTmpFiles = () => {
		for (const f of tmpFiles) {
			try { fs.unlinkSync(f); } catch { /* ignore */ }
		}
	};

	return new Promise((resolve) => {
		// Windows: shell: true delegates to cmd.exe which inherits system PATH.
		// macOS/Linux: interactive login shell so PATH set in .zshrc/.bashrc is available.
		let child: ChildProcess;
		if (Platform.isWin) {
			child = spawn(cmd, [], {
				cwd: vaultPath,
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} else {
			const userShell = os.userInfo().shell || "/bin/zsh";
			child = spawn(userShell, ["-li", "-c", cmd], {
				cwd: vaultPath,
				stdio: ["ignore", "pipe", "pipe"],
			});
		}

		activeProcesses.add(child);

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];

		child.stdout!.on("data", (data: {toString(): string}) => {
			const text = data.toString();
			stdoutChunks.push(text);
			console.debug("[WhisperCal] LLM stdout:", text);
		});

		child.stderr!.on("data", (data: {toString(): string}) => {
			const text = data.toString();
			stderrChunks.push(text);
			console.error("[WhisperCal] LLM stderr:", text);
		});

		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				// Force-kill after 5 seconds if SIGTERM doesn't work
				killTimer = setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 5000);
			}, timeoutMs);
		}

		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			activeProcesses.delete(child);
			cleanupTmpFiles();
			console.error("[WhisperCal] LLM spawn error:", err);
			resolve({exitCode: 1, stdout: "", stderr: err.message});
		});

		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			activeProcesses.delete(child);
			cleanupTmpFiles();
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
 * Open the LLM CLI in an interactive Terminal.app window for debugging.
 * The user can watch and interact with the LLM session directly.
 * Returns immediately with exitCode 0 — this is fire-and-forget.
 */
function spawnLlmPromptTerminal(opts: LlmInvokerOpts): Promise<{exitCode: number; stdout: string; stderr: string}> {
	if (!Platform.isMacOS) {
		return Promise.resolve({exitCode: 1, stdout: "", stderr: "Debug terminal mode is only available on macOS"});
	}
	const {vaultPath} = opts;
	const tmpFiles: string[] = [];

	// Cache optimization: read prompt file for system prompt injection
	let systemPromptFile: string | undefined;
	if (opts.promptPath && !opts.inlinePrompt) {
		const resolved = resolvePromptPath(opts.promptPath, opts.vaultPath);
		try {
			const content = fs.readFileSync(resolved, "utf-8");
			const tmpDir = getPluginTmpDir(opts.vaultPath);
			const tmpFile = path.join(tmpDir, `wcal-sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
			fs.writeFileSync(tmpFile, content, "utf-8");
			tmpFiles.push(tmpFile);
			systemPromptFile = tmpFile;
		} catch { /* fall back to old behavior */ }
	}

	const trigger = buildTrigger(opts, !!systemPromptFile);
	const cli = buildCliCommand(opts, systemPromptFile);
	const tmpDir = getPluginTmpDir(opts.vaultPath);
	const tmpTrigger = path.join(tmpDir, `wcal-trigger-${Date.now()}.txt`);
	fs.writeFileSync(tmpTrigger, trigger, "utf-8");
	tmpFiles.push(tmpTrigger);

	// Script: run CLI in print mode, feed trigger via stdin, then clean up.
	// buildCliCommand already includes -p for print mode.
	const tmpScript = path.join(tmpDir, `wcal-debug-${Date.now()}.sh`);
	tmpFiles.push(tmpScript);
	const rmFiles = tmpFiles.map(f => shellQuote(f)).join(" ");
	const scriptBody = `cd ${shellQuote(vaultPath)} && ${cli} < ${shellQuote(tmpTrigger)}\nrm -f ${rmFiles}\n`;
	fs.writeFileSync(tmpScript, scriptBody, "utf-8");

	// Source the script in the Terminal's login shell so PATH is inherited.
	const termCmd = `. ${shellQuote(tmpScript)}`;
	// AppleScript: escape backslashes and double quotes for the do script string.
	const asQuoted = `"${termCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	const osascript = [
		`tell application "Terminal"`,
		`  do script ${asQuoted}`,
		`  activate`,
		`end tell`,
	].join("\n");

	return new Promise((resolve) => {
		execFile("osascript", ["-e", osascript], {timeout: 10000}, (err) => {
			if (err) {
				// Clean up temp files on failure
				for (const f of tmpFiles) {
					try { fs.unlinkSync(f); } catch { /* ignore */ }
				}
				const msg = err.message;
				resolve({exitCode: 1, stdout: "", stderr: `Failed to open Terminal: ${msg}`});
			} else {
				// Debug mode is fire-and-forget — the user interacts in Terminal directly.
				// Shell script handles its own temp file cleanup after the CLI exits.
				resolve({exitCode: 0, stdout: "", stderr: ""});
			}
		});
	});
}
