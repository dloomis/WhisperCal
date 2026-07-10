import {spawn, execFile, type ChildProcess} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import process from "process";
import {Platform} from "obsidian";

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
function getPluginTmpDir(vaultPath: string, pluginDir: string): string {
	const dir = path.join(vaultPath, pluginDir, "tmp");
	// mode 0o700: the prompt/trigger files hold meeting content and live inside a
	// possibly-synced vault — keep them owner-only (no-op on Windows).
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	return dir;
}

/** Active child processes tracked for cleanup on plugin unload. */
export const activeProcesses = new Set<ChildProcess>();

/**
 * Kill a spawned LLM process and everything it started. The POSIX spawn path
 * uses detached:true so the shell leads its own process group; signalling the
 * negative pid reaches the CLI (and its children), not just the shell —
 * child.kill() alone would orphan a hung CLI to launchd on timeout.
 */
export function killProcessTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
	if (Platform.isWin && child.pid) {
		// taskkill /T kills the whole tree (PowerShell + the CLI it spawned).
		// child.kill() alone would signal only powershell.exe, orphaning a hung
		// CLI on timeout/unload. Always force with /F regardless of the requested
		// signal: the graceful WM_CLOSE form is a guaranteed no-op here because the
		// process is spawned with windowsHide (CREATE_NO_WINDOW) and has no window
		// to receive the message, so a "SIGTERM" would just waste the grace window —
		// and on plugin unload the renderer dies before the escalation timer fires,
		// leaving orphaned claude/node processes. Note: taskkill doesn't set
		// child.killed, so the spawnLlmPrompt force-kill timer always fires on
		// Windows; killing an already-dead PID just errors, which is swallowed.
		execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {timeout: 5000}, () => { /* best-effort */ });
		return;
	}
	if (child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Group already gone or not a group leader — fall through.
		}
	}
	child.kill(signal);
}

// Escape a string for use in a single-quoted shell argument: replace ' with '\''
function escapeSq(s: string): string {
	return s.replace(/'/g, "'\\''");
}

// Wrap a shell argument in single quotes (with internal escaping)
function shellQuote(s: string): string {
	return `'${escapeSq(s)}'`;
}

/** Quote a string as a PowerShell single-quoted literal ('' escapes '). */
function psQuote(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

/**
 * PowerShell prelude forcing UTF-8 on both the pipe encoding ($OutputEncoding,
 * used when piping into a native exe — ASCII by default in PS 5.1) and the
 * console decode ([Console]::OutputEncoding — OEM codepage by default), so
 * non-ASCII text survives the stdin/stdout legs. Prepended to every generated
 * Windows -Command string and .ps1 body.
 */
const WIN_PS_UTF8_PRELUDE = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ";

/**
 * Split a flag string on whitespace and append each token (quoted individually
 * to prevent injection) to flagParts. No-op for empty/whitespace-only input.
 */
function appendFlags(flagParts: string[], flags: string | undefined): void {
	if (!flags || !flags.trim()) return;
	for (const flag of flags.trim().split(/\s+/)) {
		flagParts.push(platformQuote(flag));
	}
}

/** Quote a shell argument for the current platform. */
function platformQuote(s: string): string {
	if (Platform.isWin) {
		// Windows spawns via PowerShell, so quote as a PS single-quoted literal.
		return psQuote(s);
	}
	return shellQuote(s);
}

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Clean a CLI stderr string for a user-facing excerpt. Strips ANSI, then (on the
 * Windows PowerShell path) drops PowerShell's NativeCommandError decoration
 * lines — `At line:…`, `+ CategoryInfo …`, `+ FullyQualifiedErrorId …`, and the
 * `+ … ~~~~` caret pointers — so the CLI's real error message shows through
 * instead of PS boilerplate. Harmless on POSIX (those patterns don't appear).
 */
export function cleanLlmStderr(s: string): string {
	return stripAnsi(s)
		.split(/\r?\n/)
		.filter(line => !/^\s*(At line:|\+\s+CategoryInfo|\+\s+FullyQualifiedErrorId|\+\s+.*~+\s*$)/.test(line))
		.join("\n")
		.trim();
}

/**
 * Check whether the LLM CLI is available on the user's PATH.
 * Returns true if found, false otherwise.
 */
export async function validateLlmCli(cliPath: string): Promise<boolean> {
	// A fully-qualified path is the natural workaround when the CLI isn't on PATH.
	// where.exe/`command -v` search PATH for a *pattern* and misreport absolute
	// paths as "not found", which would hard-gate every LLM job — so check the
	// file directly instead.
	if (path.isAbsolute(cliPath)) {
		try { return fs.existsSync(cliPath); } catch { return false; }
	}
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
	// Accept both separators after ~ so Windows-style `~\path` also expands.
	if (promptPath.startsWith("~/") || promptPath.startsWith("~\\")) return path.join(os.homedir(), promptPath.slice(2));
	return path.join(vaultPath, promptPath);
}

/**
 * Build the trigger string (prompt) from LlmInvokerOpts.
 * When promptInSystem is true, the prompt file content has been injected into
 * the system message via --append-system-prompt, so omit the file reference.
 */
function buildTrigger(opts: LlmInvokerOpts, promptInSystem = false): string {
	const parts: string[] = [];
	if (promptInSystem) {
		// Static instructions live in the system prompt — omit from user message.
	} else if (opts.inlinePrompt) {
		parts.push(opts.inlinePrompt);
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
	// PowerShell's $(Get-Content -Raw …) subexpression is the direct analog, giving
	// Windows the same system-prompt authority and prompt-cache behavior.
	if (systemPromptFile) {
		// Windows never reaches the isWin branch here — buildLlmCommand delivers the
		// prompt via the user message on Windows (see review #1), so systemPromptFile
		// is POSIX-only. The Windows form (with -Encoding UTF8) is kept defensive in
		// case a future caller opts back into system-prompt delivery on Windows.
		flagParts.push(
			Platform.isWin
				? `--append-system-prompt "$(Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(systemPromptFile)})"`
				: `--append-system-prompt "$(cat ${shellQuote(systemPromptFile)})"`,
		);
	}
	if (opts.llmModel) flagParts.push(`--model ${platformQuote(opts.llmModel)}`);
	// Global flags first, then per-prompt flags so a prompt-specific value can
	// override a general one (later flags win in most CLIs).
	appendFlags(flagParts, opts.llmExtraFlags);
	appendFlags(flagParts, opts.llmPromptFlags);
	const flags = flagParts.join(" ");
	// On Windows the CLI runs under PowerShell, where a quoted command name must be
	// invoked with the `&` call operator; it resolves .exe/.cmd/.ps1 shims off PATH.
	const cliToken = Platform.isWin ? `& ${psQuote(opts.llmCli)}` : platformQuote(opts.llmCli);
	return `${cliToken}${flags ? " " + flags : ""}`;
}

/**
 * Build the full shell command string from LlmInvokerOpts.
 * Pipes the trigger via stdin to avoid OS argument length limits.
 *
 * Prompt cache optimization (all platforms): when a prompt file is set,
 * reads it into a temp file and passes the content via --append-system-prompt.
 * This places static instructions in the system prefix where they're cached
 * by the API, keeping only variable parameters in the user message.
 * Falls back to the original "Follow the instructions in..." trigger if the
 * prompt file can't be read (e.g. missing or permissions).
 */
function buildLlmCommand(opts: LlmInvokerOpts): {cmd: string; trigger: string; vaultPath: string; tmpFiles: string[]} {
	const tmpFiles: string[] = [];
	let systemPromptFile: string | undefined;
	let windowsUserPrompt: string | undefined;

	// Read the static instructions (prompt file or inline prompt). On POSIX we
	// inject them into the system prefix via --append-system-prompt. Two reasons:
	//   1. Cache: tools → system → messages is the cacheable prefix; keeping
	//      variables in the user message preserves cache hits across runs.
	//   2. Authority: the model treats system-prompt rules ("use the Edit tool",
	//      etc.) as contracts. The same rules in the user message read like a
	//      request, and Claude in print mode tends to answer in text instead.
	// On Windows we DELIVER THE PROMPT IN THE USER MESSAGE instead. Windows spawns
	// under PowerShell 5.1, whose legacy native-argument passing does not escape
	// embedded double quotes when building the child command line — and all bundled
	// prompts contain `"`, so `--append-system-prompt "$(Get-Content …)"` would
	// shatter into garbage tokens and fail on every default-config run (review #1).
	// Prepending the prompt to the stdin trigger sidesteps command-line quoting
	// entirely (at the cost of prompt-cache/system-authority on Windows only).
	// inlinePrompt wins when both are set (bypass mode).
	{
		let content: string | undefined;
		if (opts.inlinePrompt) {
			content = opts.inlinePrompt;
		} else if (opts.promptPath) {
			const resolved = resolvePromptPath(opts.promptPath, opts.vaultPath);
			try {
				content = fs.readFileSync(resolved, "utf-8");
			} catch {
				// Prompt file unreadable — fall back to user-message delivery.
			}
		}
		if (content !== undefined) {
			if (Platform.isWin) {
				windowsUserPrompt = content;
			} else {
				try {
					const tmpFile = path.join(getPluginTmpDir(opts.vaultPath, opts.pluginDir), `wcal-sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
					fs.writeFileSync(tmpFile, content, {encoding: "utf-8", mode: 0o600});
					tmpFiles.push(tmpFile);
					systemPromptFile = tmpFile;
				} catch {
					// Temp write failed — fall back to user-message delivery.
				}
			}
		}
	}

	// promptInSystem omits the prompt reference from the trigger both when it lives
	// in the system prompt (POSIX) and when we inline it into the user message below
	// (Windows) — in the latter case we prepend the raw content instead.
	let trigger = buildTrigger(opts, !!systemPromptFile || windowsUserPrompt !== undefined);
	if (windowsUserPrompt !== undefined) trigger = `${windowsUserPrompt}\n\n${trigger}`;
	const cli = buildCliCommand(opts, systemPromptFile);

	let cmd: string;
	if (Platform.isWin) {
		// cmd.exe has no heredocs, so write the trigger to a temp file and pipe it
		// into the CLI via PowerShell. Get-Content -Raw feeds stdin the same way the
		// POSIX heredoc does, avoiding ENAMETOOLONG on long prompts; `cli` already
		// carries the `&` call operator that invokes the quoted CLI name off PATH.
		// -Encoding UTF8 + the $OutputEncoding/[Console]::OutputEncoding prelude keep
		// non-ASCII text (accented names) intact through the read → stdin → stdout
		// legs; PS 5.1 defaults (ANSI read, ASCII pipe, OEM console) mangle it (#2).
		const tmpTrigger = path.join(getPluginTmpDir(opts.vaultPath, opts.pluginDir), `wcal-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
		fs.writeFileSync(tmpTrigger, trigger, {encoding: "utf-8", mode: 0o600});
		tmpFiles.push(tmpTrigger);
		cmd = `${WIN_PS_UTF8_PRELUDE}Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(tmpTrigger)} | ${cli}`;
	} else {
		// Pipe trigger via stdin using a heredoc to avoid ENAMETOOLONG on long prompts.
		// Randomize the delimiter per invocation: a fixed sentinel could appear
		// verbatim in third-party trigger content (attendee names, roster,
		// instructions) and prematurely close the heredoc, spilling the rest into
		// the login shell. A random token can't be predicted or injected.
		const eof = `__WCAL_EOF_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}__`;
		cmd = `${cli} <<'${eof}'\n${trigger}\n${eof}`;
	}
	return {cmd, trigger, vaultPath: opts.vaultPath, tmpFiles};
}

/**
 * Spawn the LLM CLI as a background child process (no terminal window).
 * Returns the exit code and any stderr output when the process finishes.
 */
export function spawnLlmPrompt(opts: LlmInvokerOpts): Promise<{exitCode: number; stdout: string; stderr: string}> {
	// Ensure any --mcp-config file referenced in flags exists (may be missing after reboot).
	ensureMcpConfigFile(opts.llmExtraFlags);
	if (opts.llmPromptFlags) ensureMcpConfigFile(opts.llmPromptFlags);

	if (opts.debugMode) {
		return spawnLlmPromptTerminal(opts);
	}

	const {cmd, trigger, vaultPath, tmpFiles} = buildLlmCommand(opts);
	const timeoutMs = opts.timeoutMs ?? 0;
	if (opts.debugLogging) {
		// eslint-disable-next-line no-console
		console.log("[WhisperCal] LLM command:", cmd);
		// eslint-disable-next-line no-console
		console.log("[WhisperCal] LLM trigger:", trigger);
	}

	const cleanupTmpFiles = () => {
		for (const f of tmpFiles) {
			try { fs.unlinkSync(f); } catch { /* ignore */ }
		}
	};

	return new Promise((resolve) => {
		// Windows: run the pipeline under PowerShell, which inherits system PATH and
		// (unlike cmd.exe) supports the Get-Content pipe and $( ) subexpression the
		// command relies on. windowsHide keeps the console window from flashing.
		// macOS/Linux: interactive login shell so PATH set in .zshrc/.bashrc is available.
		let child: ChildProcess;
		if (Platform.isWin) {
			child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
				cwd: vaultPath,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} else {
			const userShell = os.userInfo().shell || "/bin/zsh";
			child = spawn(userShell, ["-li", "-c", cmd], {
				cwd: vaultPath,
				stdio: ["ignore", "pipe", "pipe"],
				// Own process group so timeout/unload kills reach the CLI the
				// shell spawns, not just the shell — see killProcessTree.
				detached: true,
			});
		}

		activeProcesses.add(child);

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];

		child.stdout!.on("data", (data: {toString(): string}) => {
			const text = data.toString();
			stdoutChunks.push(text);
			if (opts.debugLogging) console.debug("[WhisperCal] LLM stdout:", text);
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
				killProcessTree(child, "SIGTERM");
				// Force-kill after 5 seconds if SIGTERM doesn't work
				killTimer = setTimeout(() => {
					if (!child.killed) killProcessTree(child, "SIGKILL");
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
	if (!Platform.isMacOS && !Platform.isWin) {
		return Promise.resolve({exitCode: 1, stdout: "", stderr: "Debug terminal mode is only available on macOS and Windows"});
	}
	const {vaultPath} = opts;
	const tmpFiles: string[] = [];

	// Inject prompt file or inline prompt into the system prefix (see buildLlmCommand).
	// On Windows deliver it via the user message instead (PS 5.1 quoting — review #1).
	let systemPromptFile: string | undefined;
	let windowsUserPrompt: string | undefined;
	let systemPromptContent: string | undefined;
	if (opts.inlinePrompt) {
		systemPromptContent = opts.inlinePrompt;
	} else if (opts.promptPath) {
		const resolved = resolvePromptPath(opts.promptPath, opts.vaultPath);
		try {
			systemPromptContent = fs.readFileSync(resolved, "utf-8");
		} catch { /* fall back to user-message delivery */ }
	}
	if (systemPromptContent !== undefined) {
		if (Platform.isWin) {
			windowsUserPrompt = systemPromptContent;
		} else {
			try {
				const sysDir = getPluginTmpDir(opts.vaultPath, opts.pluginDir);
				const tmpFile = path.join(sysDir, `wcal-sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
				fs.writeFileSync(tmpFile, systemPromptContent, {encoding: "utf-8", mode: 0o600});
				tmpFiles.push(tmpFile);
				systemPromptFile = tmpFile;
			} catch { /* fall back */ }
		}
	}

	let trigger = buildTrigger(opts, !!systemPromptFile || windowsUserPrompt !== undefined);
	if (windowsUserPrompt !== undefined) trigger = `${windowsUserPrompt}\n\n${trigger}`;
	const cli = buildCliCommand(opts, systemPromptFile);
	const tmpDir = getPluginTmpDir(opts.vaultPath, opts.pluginDir);
	const tmpTrigger = path.join(tmpDir, `wcal-trigger-${Date.now()}.txt`);
	fs.writeFileSync(tmpTrigger, trigger, {encoding: "utf-8", mode: 0o600});
	tmpFiles.push(tmpTrigger);

	if (Platform.isWin) {
		return spawnWindowsDebugTerminal(cli, tmpTrigger, tmpDir, vaultPath, tmpFiles);
	}

	// Script: run CLI in print mode, feed trigger via stdin, then clean up.
	// buildCliCommand already includes -p for print mode.
	const tmpScript = path.join(tmpDir, `wcal-debug-${Date.now()}.sh`);
	tmpFiles.push(tmpScript);
	const rmFiles = tmpFiles.map(f => shellQuote(f)).join(" ");
	const scriptBody = `cd ${shellQuote(vaultPath)} && ${cli} < ${shellQuote(tmpTrigger)}\nrm -f ${rmFiles}\n`;
	fs.writeFileSync(tmpScript, scriptBody, {encoding: "utf-8", mode: 0o600});

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

/**
 * Windows analog of the macOS Terminal.app debug launch: write a `.ps1` runner
 * (PATH-inheriting PowerShell) that pipes the trigger into the CLI and self-cleans,
 * then open it in a visible window — Windows Terminal (`wt.exe`) when available,
 * else `cmd /c start … powershell`. `-NoExit` keeps the window open to read output.
 */
function spawnWindowsDebugTerminal(
	cli: string,
	tmpTrigger: string,
	tmpDir: string,
	vaultPath: string,
	tmpFiles: string[],
): Promise<{exitCode: number; stdout: string; stderr: string}> {
	const tmpScript = path.join(tmpDir, `wcal-debug-${Date.now()}.ps1`);
	tmpFiles.push(tmpScript);
	// `cli` is already a PowerShell fragment (`& '<cli>' <flags>`), so the runner
	// mirrors the background command form. Remove-Item cleans up after the CLI exits.
	const rmList = tmpFiles.map(f => psQuote(f)).join(",");
	const scriptBody = [
		// Force UTF-8 on pipe + console so accented names survive (see #2); -Encoding
		// UTF8 reads the BOM-less trigger correctly (PS 5.1 defaults to ANSI).
		WIN_PS_UTF8_PRELUDE.trim(),
		`Set-Location -LiteralPath ${psQuote(vaultPath)}`,
		`Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(tmpTrigger)} | ${cli}`,
		`Remove-Item -LiteralPath ${rmList} -ErrorAction SilentlyContinue`,
	].join("\r\n") + "\r\n";
	// Write with a UTF-8 BOM so PS 5.1 parses the .ps1 itself as UTF-8, not ANSI.
	fs.writeFileSync(tmpScript, "﻿" + scriptBody, {encoding: "utf-8", mode: 0o600});

	const psArgs = ["-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", tmpScript];

	const cleanup = () => {
		for (const f of tmpFiles) {
			try { fs.unlinkSync(f); } catch { /* ignore */ }
		}
	};

	return new Promise((resolve) => {
		// Prefer Windows Terminal (nicer window); fall back to a classic console.
		const wt = spawn("wt.exe", ["powershell.exe", ...psArgs], {detached: true, stdio: "ignore"});
		wt.on("error", () => {
			// wt.exe not installed — launch a detached PowerShell console via start.
			const fallback = spawn(
				"cmd.exe",
				["/c", "start", "", "powershell.exe", ...psArgs],
				{detached: true, stdio: "ignore", windowsHide: false},
			);
			fallback.on("error", (err) => {
				cleanup();
				resolve({exitCode: 1, stdout: "", stderr: `Failed to open terminal: ${err.message}`});
			});
			fallback.on("spawn", () => {
				fallback.unref();
				resolve({exitCode: 0, stdout: "", stderr: ""});
			});
		});
		wt.on("spawn", () => {
			wt.unref();
			resolve({exitCode: 0, stdout: "", stderr: ""});
		});
	});
}
