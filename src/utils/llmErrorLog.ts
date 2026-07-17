import {App, TFile} from "obsidian";
import {stripAnsi} from "../services/LlmInvoker";

const ERRORS_HEADING = "## LLM Errors";

export interface LlmErrorDetails {
	label: string;
	exitCode: number;
	stderr: string;
	stdout?: string;
	cli?: string;
	model?: string;
}

/**
 * Append a timestamped LLM error subentry to the meeting note.
 * Creates a `## LLM Errors` section if one doesn't already exist;
 * otherwise appends the new `### {label} — {timestamp}` block within it.
 */
export async function appendLlmErrorSection(
	app: App,
	notePath: string,
	details: LlmErrorDetails,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) {
		console.error(`[WhisperCal] appendLlmErrorSection: no file at "${notePath}"`);
		return;
	}
	const entry = buildErrorEntry(details);
	try {
		await app.vault.process(file, (content) => insertErrorEntry(content, entry));
	} catch (e) {
		console.error(`[WhisperCal] appendLlmErrorSection: failed to write to "${notePath}":`, e);
	}
}

function buildErrorEntry(d: LlmErrorDetails): string {
	const ts = formatLocalTimestamp(new Date());
	const lines: string[] = [];
	lines.push(`### ${d.label} — ${ts}`);
	lines.push(`- Exit code: \`${d.exitCode}\``);
	if (d.cli) lines.push(`- CLI: \`${d.cli}\``);
	if (d.model) lines.push(`- Model: \`${d.model}\``);

	const stderr = stripAnsi(d.stderr).trim();
	if (stderr) {
		lines.push("");
		lines.push("**stderr:**");
		lines.push("");
		lines.push(fenceBlock(stderr));
	}

	const stdout = d.stdout ? stripAnsi(d.stdout).trim() : "";
	if (stdout) {
		lines.push("");
		lines.push("**stdout:**");
		lines.push("");
		lines.push(fenceBlock(stdout));
	}

	return lines.join("\n");
}

/** "YYYY-MM-DD HH:MM:SS" in local time. */
function formatLocalTimestamp(d: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Wrap text in a code fence longer than any backtick run inside it. */
function fenceBlock(text: string): string {
	let max = 0;
	for (const m of text.matchAll(/`+/g)) max = Math.max(max, m[0].length);
	const fence = "`".repeat(Math.max(3, max + 1));
	return `${fence}\n${text}\n${fence}`;
}

/**
 * Insert `entry` into `content` under the `## LLM Errors` heading.
 * Creates the heading at end-of-file if absent; otherwise appends the entry
 * after the last existing entry, before the next H1/H2 boundary.
 */
export function insertErrorEntry(content: string, entry: string): string {
	const lines = content.split("\n");
	const headingIdx = lines.findIndex(l => l.trim() === ERRORS_HEADING);

	if (headingIdx === -1) {
		const trailing = content.length === 0 || content.endsWith("\n") ? "" : "\n";
		const sep = content.length === 0 ? "" : "\n";
		return `${content}${trailing}${sep}${ERRORS_HEADING}\n\n${entry}\n`;
	}

	// Find the next H1/H2 that actually ends the section. Earlier entries fence
	// raw CLI output, which routinely contains #-prefixed lines; treating one of
	// those as the boundary would splice the new entry into the middle of the old
	// fenced block, breaking the fence and spilling the output into the note body.
	let nextSectionIdx = lines.length;
	let fence: string | null = null;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		const line = lines[i]!;
		const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			// A closing fence must be at least as long as the one that opened it and
			// use the same character; anything else is still inside the block.
			if (fence === null) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
			continue;
		}
		if (fence === null && /^#{1,2} /.test(line)) {
			nextSectionIdx = i;
			break;
		}
	}

	let endIdx = nextSectionIdx;
	while (endIdx > headingIdx + 1 && lines[endIdx - 1] === "") endIdx--;

	const before = lines.slice(0, endIdx);
	const after = lines.slice(nextSectionIdx);

	const out = [...before, "", entry, "", ...after];
	return out.join("\n");
}
