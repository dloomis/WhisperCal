import {execFile} from "child_process";
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
	// Optional parameters that skip prompt steps when provided
	microphoneUser?: string;
	transcriptFolderPath?: string;  // folder name for transcript files
	peopleFolderPath?: string;      // folder name for People notes
}

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

	// Resolve prompt path to absolute
	let resolvedPromptPath: string;
	if (promptPath.startsWith("/")) {
		resolvedPromptPath = promptPath;
	} else if (promptPath.startsWith("~/")) {
		resolvedPromptPath = path.join(os.homedir(), promptPath.slice(2));
	} else {
		resolvedPromptPath = path.join(vaultPath, promptPath);
	}

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
	const asCmd = asAppleScriptStr(`bash ${shellQuote(tmpScript)}`);
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
	activate
end tell`;
	} else {
		if (autoCloseTerminal) {
			// Terminal.app: run the command, then close the specific window when done.
			// "do script" returns a tab reference; its `window` property tracks the window.
			applescript = `tell application "Terminal"
	set newTab to do script ${asCmd}
	set targetWindow to window of newTab
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
	activate
end tell`;
		}
	}

	execFile("osascript", ["-e", applescript], (err) => {
		if (err) console.error("[WhisperCal] LlmInvoker osascript error:", err);
	});
}
