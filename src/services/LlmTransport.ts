import {spawn, execFile, type ChildProcess} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import process from "process";
import {Platform} from "obsidian";

/**
 * Generic LLM CLI transport (DESIGN C5, WhisperCore DESIGN D3).
 *
 * This layer is the future WhisperCore API v2 `runLlmPrompt` primitive, staged
 * inside WhisperCal. It knows how to run a CLI: process spawn and process-tree
 * kills, Windows PowerShell UTF-8 quoting, timeouts, MCP-config plumbing, the
 * machine-wide concurrency slot counter, and the system-prompt/user-message
 * delivery mechanics per platform.
 *
 * It must stay product-blind: NOTHING below this line may know about prompt
 * files, trigger assembly, meeting semantics, job kinds, banners, or cards.
 * Callers hand it already-assembled text (`systemPrompt`, `userMessage`) and a
 * temp directory; everything it receives is plain data.
 */

/** One CLI run, fully assembled. */
export interface LlmTransportRequest {
	/** Static instructions. On POSIX these are injected into the system prefix
	 *  via --append-system-prompt (prompt-cache + authority); on Windows — or if
	 *  the temp-file write fails — they are prepended to `userMessage` instead
	 *  (PS 5.1 native-arg quoting cannot carry embedded double quotes). */
	systemPrompt?: string;
	/** The per-run message, piped to the CLI via stdin. */
	userMessage: string;
	cli: string;              // CLI command or absolute path
	extraFlags: string;       // base flags appended to every invocation
	promptFlags?: string;     // per-run flags appended after extraFlags (later flags win)
	model?: string;           // model ID passed via --model (empty = CLI default)
	cwd: string;              // working directory for the CLI (the vault root)
	/** Absolute directory for transport temp files (created 0o700 if missing). */
	tmpDir: string;
	timeoutMs?: number;       // kill the process tree after this many ms (0 = no timeout)
	debugMode?: boolean;      // open a visible terminal instead of running headless
	debugLogging?: boolean;   // log command/message/stdout to the developer console
}

export interface LlmTransportResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

// ── Concurrency slots (machine-wide cap lives here, not per call site) ──

let activeLlmSlots = 0;

/** Number of currently claimed LLM slots. */
export function activeLlmCount(): number {
	return activeLlmSlots;
}

/** Claim a concurrency slot. Callers check `activeLlmCount()` against their cap
 *  first; claim synchronously with the check so check-then-use stays atomic. */
export function claimLlmSlot(): void {
	activeLlmSlots++;
}

/** Release a claimed slot. Floored at zero so a double release cannot wedge the
 *  counter negative and mask the cap. */
export function releaseLlmSlot(): void {
	if (activeLlmSlots > 0) activeLlmSlots--;
}

// ── Process tracking / kills ──

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
		// child.killed, so the runLlm force-kill timer always fires on
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

// ── Quoting / shell selection ──

// Escape a string for use in a single-quoted shell argument: replace ' with '\''
function escapeSq(s: string): string {
	return s.replace(/'/g, "'\\''");
}

// Wrap a shell argument in single quotes (with internal escaping)
function shellQuote(s: string): string {
	return `'${escapeSq(s)}'`;
}

/** Login shells whose syntax isn't POSIX. The command lines built here use
 *  heredocs, `$( )`, and POSIX quoting, so they can't run under these directly. */
const NON_POSIX_SHELL_RE = /(?:^|\/)(?:fish|tcsh|csh)$/;

/**
 * Build the spawn argv for running a POSIX command line on macOS/Linux.
 *
 * The user's login shell is preferred because PATH is typically set in its rc
 * file, and the CLI has to be findable. But a fish/tcsh login shell would choke
 * on the POSIX syntax we generate, failing every LLM job with an opaque syntax
 * error. fish can still supply PATH — exec a POSIX shell under it. tcsh/csh
 * can't (`-l` doesn't combine with `-c` there), so fall back to zsh outright and
 * accept whatever PATH the system provides.
 */
function posixShellArgs(cmd: string): {shell: string; args: string[]} {
	const userShell = os.userInfo().shell || "/bin/zsh";
	if (!NON_POSIX_SHELL_RE.test(userShell)) return {shell: userShell, args: ["-li", "-c", cmd]};
	if (/(?:^|\/)fish$/.test(userShell)) {
		// config.fish (which sets PATH) is read for login shells; single-quoted
		// escaping concatenates the same way it does in POSIX, so shellQuote holds.
		return {shell: userShell, args: ["-l", "-c", `exec /bin/zsh -c ${shellQuote(cmd)}`]};
	}
	return {shell: "/bin/zsh", args: ["-li", "-c", cmd]};
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

// ── Output cleanup ──

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

// ── CLI availability ──

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
	// Login shell so PATH set in .zshrc/.bashrc is available; posixShellArgs keeps
	// `command -v` (a POSIX builtin tcsh doesn't have) running under a POSIX shell.
	const {shell, args} = posixShellArgs(`command -v ${shellQuote(cliPath)}`);
	return new Promise((resolve) => {
		const child = spawn(shell, args, {
			stdio: ["ignore", "ignore", "ignore"],
		});
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}

// ── MCP config / temp files ──

/**
 * If a flag string references a --mcp-config file, ensure it exists.
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

/** Ensure the transport temp dir exists.
 *  mode 0o700: the prompt/trigger files can hold sensitive content and may live
 *  inside a synced vault — keep them owner-only (no-op on Windows). */
function ensureTmpDir(dir: string): string {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
	return dir;
}

function tmpFileName(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
}

// ── Command assembly ──

/**
 * Build the CLI + flags portion of the shell command (without the user message).
 * When systemPromptFile is set, adds --append-system-prompt to inject the static
 * instructions into the system message for prompt cache optimization.
 */
function buildCliCommand(req: LlmTransportRequest, systemPromptFile?: string): string {
	const flagParts: string[] = [];
	// Print mode: process one prompt via stdin and exit (no interactive TUI).
	flagParts.push("-p");
	// Skip loading user skills — they inflate the system prompt with irrelevant context.
	flagParts.push("--disable-slash-commands");
	// Don't persist session data to disk — these are ephemeral worker runs.
	flagParts.push("--no-session-persistence");
	// Inject static instructions into the system message so they land in the
	// cacheable prefix (tools → system → messages). Without this, the LLM would
	// see the instructions after the variable user message — which changes the
	// prefix hash and prevents cache hits.
	// $(cat file) inside double quotes is safe: the shell does not re-expand the result.
	// PowerShell's $(Get-Content -Raw …) subexpression is the direct analog, giving
	// Windows the same system-prompt authority and prompt-cache behavior.
	if (systemPromptFile) {
		// Windows never reaches the isWin branch here — runLlm delivers the
		// instructions via the user message on Windows (see review #1), so
		// systemPromptFile is POSIX-only. The Windows form (with -Encoding UTF8) is
		// kept defensive in case a future caller opts back into system-prompt
		// delivery on Windows.
		flagParts.push(
			Platform.isWin
				? `--append-system-prompt "$(Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(systemPromptFile)})"`
				: `--append-system-prompt "$(cat ${shellQuote(systemPromptFile)})"`,
		);
	}
	if (req.model) flagParts.push(`--model ${platformQuote(req.model)}`);
	// Base flags first, then per-run flags so a specific value can override a
	// general one (later flags win in most CLIs).
	appendFlags(flagParts, req.extraFlags);
	appendFlags(flagParts, req.promptFlags);
	const flags = flagParts.join(" ");
	// On Windows the CLI runs under PowerShell, where a quoted command name must be
	// invoked with the `&` call operator; it resolves .exe/.cmd/.ps1 shims off PATH.
	const cliToken = Platform.isWin ? `& ${psQuote(req.cli)}` : platformQuote(req.cli);
	return `${cliToken}${flags ? " " + flags : ""}`;
}

/**
 * Build the full shell command string for a request.
 * Pipes the user message via stdin to avoid OS argument length limits.
 *
 * Prompt cache optimization (POSIX): `systemPrompt` is written to a temp file
 * and passed via --append-system-prompt, placing static instructions in the
 * system prefix where the API caches them, keeping only variable content in the
 * user message. On Windows — or if the temp write fails — the instructions are
 * prepended to the user message instead: PowerShell 5.1's legacy native-argument
 * passing does not escape embedded double quotes when building the child command
 * line, so `--append-system-prompt "$(Get-Content …)"` would shatter into
 * garbage tokens on any instruction text containing `"` (review #1).
 */
function buildCommand(req: LlmTransportRequest): {cmd: string; message: string; tmpFiles: string[]} {
	const tmpFiles: string[] = [];
	let systemPromptFile: string | undefined;
	let message = req.userMessage;

	if (req.systemPrompt !== undefined) {
		let delivered = false;
		if (!Platform.isWin) {
			try {
				const tmpFile = path.join(ensureTmpDir(req.tmpDir), tmpFileName("wcal-sys"));
				fs.writeFileSync(tmpFile, req.systemPrompt, {encoding: "utf-8", mode: 0o600});
				tmpFiles.push(tmpFile);
				systemPromptFile = tmpFile;
				delivered = true;
			} catch {
				// Temp write failed — fall back to user-message delivery below.
			}
		}
		if (!delivered) message = `${req.systemPrompt}\n\n${message}`;
	}

	const cli = buildCliCommand(req, systemPromptFile);

	let cmd: string;
	if (Platform.isWin) {
		// cmd.exe has no heredocs, so write the message to a temp file and pipe it
		// into the CLI via PowerShell. Get-Content -Raw feeds stdin the same way the
		// POSIX heredoc does, avoiding ENAMETOOLONG on long prompts; `cli` already
		// carries the `&` call operator that invokes the quoted CLI name off PATH.
		// -Encoding UTF8 + the $OutputEncoding/[Console]::OutputEncoding prelude keep
		// non-ASCII text (accented names) intact through the read → stdin → stdout
		// legs; PS 5.1 defaults (ANSI read, ASCII pipe, OEM console) mangle it (#2).
		const tmpTrigger = path.join(ensureTmpDir(req.tmpDir), tmpFileName("wcal-trigger"));
		fs.writeFileSync(tmpTrigger, message, {encoding: "utf-8", mode: 0o600});
		tmpFiles.push(tmpTrigger);
		cmd = `${WIN_PS_UTF8_PRELUDE}Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(tmpTrigger)} | ${cli}`;
	} else {
		// Pipe the message via stdin using a heredoc to avoid ENAMETOOLONG on long
		// prompts. Randomize the delimiter per invocation: a fixed sentinel could
		// appear verbatim in third-party message content and prematurely close the
		// heredoc, spilling the rest into the login shell. A random token can't be
		// predicted or injected.
		const eof = `__WCAL_EOF_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}__`;
		cmd = `${cli} <<'${eof}'\n${message}\n${eof}`;
	}
	return {cmd, message, tmpFiles};
}

// ── The engine ──

/**
 * Run the LLM CLI as a background child process (no terminal window).
 * Resolves with the exit code and any output when the process finishes; never
 * rejects. With `debugMode` set, opens a visible terminal instead (fire-and-forget).
 */
export function runLlm(req: LlmTransportRequest): Promise<LlmTransportResult> {
	// Ensure any --mcp-config file referenced in flags exists (may be missing after reboot).
	ensureMcpConfigFile(req.extraFlags);
	if (req.promptFlags) ensureMcpConfigFile(req.promptFlags);

	if (req.debugMode) {
		return runLlmTerminal(req);
	}

	const {cmd, message, tmpFiles} = buildCommand(req);
	const timeoutMs = req.timeoutMs ?? 0;
	if (req.debugLogging) {
		// eslint-disable-next-line no-console
		console.log("[WhisperCal] LLM command:", cmd);
		// eslint-disable-next-line no-console
		console.log("[WhisperCal] LLM trigger:", message);
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
				cwd: req.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} else {
			const {shell, args} = posixShellArgs(cmd);
			child = spawn(shell, args, {
				cwd: req.cwd,
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
			if (req.debugLogging) console.debug("[WhisperCal] LLM stdout:", text);
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

// ── Debug terminal ──

/**
 * Open the LLM CLI in an interactive terminal window for debugging.
 * The user can watch and interact with the LLM session directly.
 * Returns immediately with exitCode 0 — this is fire-and-forget.
 */
function runLlmTerminal(req: LlmTransportRequest): Promise<LlmTransportResult> {
	if (!Platform.isMacOS && !Platform.isWin) {
		return Promise.resolve({exitCode: 1, stdout: "", stderr: "Debug terminal mode is only available on macOS and Windows"});
	}
	const tmpFiles: string[] = [];

	// Same delivery split as buildCommand: system prefix on POSIX, user-message
	// prepend on Windows or when the temp write fails (PS 5.1 quoting — review #1).
	let systemPromptFile: string | undefined;
	let message = req.userMessage;
	if (req.systemPrompt !== undefined) {
		let delivered = false;
		if (!Platform.isWin) {
			try {
				const tmpFile = path.join(ensureTmpDir(req.tmpDir), tmpFileName("wcal-sys"));
				fs.writeFileSync(tmpFile, req.systemPrompt, {encoding: "utf-8", mode: 0o600});
				tmpFiles.push(tmpFile);
				systemPromptFile = tmpFile;
				delivered = true;
			} catch { /* fall back */ }
		}
		if (!delivered) message = `${req.systemPrompt}\n\n${message}`;
	}

	const cli = buildCliCommand(req, systemPromptFile);
	const tmpDir = ensureTmpDir(req.tmpDir);
	const tmpTrigger = path.join(tmpDir, `wcal-trigger-${Date.now()}.txt`);
	fs.writeFileSync(tmpTrigger, message, {encoding: "utf-8", mode: 0o600});
	tmpFiles.push(tmpTrigger);

	if (Platform.isWin) {
		return spawnWindowsDebugTerminal(cli, tmpTrigger, tmpDir, req.cwd, tmpFiles);
	}

	// Script: run CLI in print mode, feed the message via stdin, then clean up.
	// buildCliCommand already includes -p for print mode.
	const tmpScript = path.join(tmpDir, `wcal-debug-${Date.now()}.sh`);
	tmpFiles.push(tmpScript);
	const rmFiles = tmpFiles.map(f => shellQuote(f)).join(" ");
	const scriptBody = `cd ${shellQuote(req.cwd)} && ${cli} < ${shellQuote(tmpTrigger)}\nrm -f ${rmFiles}\n`;
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
 * (PATH-inheriting PowerShell) that pipes the message into the CLI and self-cleans,
 * then open it in a visible window — Windows Terminal (`wt.exe`) when available,
 * else `cmd /c start … powershell`. `-NoExit` keeps the window open to read output.
 */
function spawnWindowsDebugTerminal(
	cli: string,
	tmpTrigger: string,
	tmpDir: string,
	cwd: string,
	tmpFiles: string[],
): Promise<LlmTransportResult> {
	const tmpScript = path.join(tmpDir, `wcal-debug-${Date.now()}.ps1`);
	tmpFiles.push(tmpScript);
	// `cli` is already a PowerShell fragment (`& '<cli>' <flags>`), so the runner
	// mirrors the background command form. Remove-Item cleans up after the CLI exits.
	const rmList = tmpFiles.map(f => psQuote(f)).join(",");
	const scriptBody = [
		// Force UTF-8 on pipe + console so accented names survive (see #2); -Encoding
		// UTF8 reads the BOM-less trigger correctly (PS 5.1 defaults to ANSI).
		WIN_PS_UTF8_PRELUDE.trim(),
		`Set-Location -LiteralPath ${psQuote(cwd)}`,
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
