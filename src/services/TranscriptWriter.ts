import type {App} from "obsidian";
import {TFile, TFolder} from "obsidian";
import {getTranscript} from "./MacWhisperDb";
import type {TranscriptData} from "./MacWhisperDb";
import {updateFrontmatter} from "../utils/frontmatter";

interface SpeakerBlock {
	speaker: string | null;
	startMs: number;
	lines: string[];
}

function getTranscriptPath(notePath: string, transcriptFolderPath: string): string {
	// Extract basename without extension from the meeting note path
	const basename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "Transcript";
	return `${transcriptFolderPath}/${basename} - Transcript.md`;
}

function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTimestamp(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	return formatDuration(totalSec);
}

function groupBySpeaker(lines: TranscriptData["lines"]): SpeakerBlock[] {
	const blocks: SpeakerBlock[] = [];
	for (const line of lines) {
		const last = blocks[blocks.length - 1];
		if (last && last.speaker === line.speaker) {
			last.lines.push(line.text);
		} else {
			blocks.push({
				speaker: line.speaker,
				startMs: line.startMs,
				lines: [line.text],
			});
		}
	}
	return blocks;
}

function buildFrontmatter(opts: {
	notePath: string;
	sessionId: string;
	metadata: NonNullable<TranscriptData["metadata"]>;
	speakers: string[];
}): string {
	const {notePath, sessionId, metadata, speakers} = opts;

	const noteBasename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
	const meetingNoteLink = `"[[${noteBasename}]]"`;

	// Parse recording date from dateCreated
	const recordingDate = metadata.dateCreated
		? metadata.dateCreated.substring(0, 10)
		: "";

	const duration = metadata.durationSec
		? formatDuration(metadata.durationSec)
		: "";

	const speakerYaml = speakers.length > 0
		? speakers.map(s => `  - "${s}"`).join("\n")
		: "";

	const diarized = metadata.hasBeenDiarized ? "true" : "false";
	const model = metadata.modelIdentifer ?? "";
	const engine = metadata.modelEngine ?? "";
	const language = metadata.detectedLanguage ?? metadata.modelInputLanguage ?? "";

	const lines = [
		"---",
		"type: transcript",
		`meeting_note: ${meetingNoteLink}`,
		`macwhisper_session_id: "${sessionId}"`,
	];

	if (recordingDate) lines.push(`recording_date: ${recordingDate}`);
	if (duration) lines.push(`duration: "${duration}"`);

	if (speakerYaml) {
		lines.push("speakers:");
		lines.push(speakerYaml);
	}

	lines.push(`diarized: ${diarized}`);
	if (model) lines.push(`whisper_model: "${model}"`);
	if (engine) lines.push(`whisper_engine: "${engine}"`);
	if (language) lines.push(`language: "${language}"`);
	lines.push("tags: [transcript]");
	lines.push("---");

	return lines.join("\n");
}

function buildTranscriptBody(data: TranscriptData): string {
	const sections: string[] = [];

	sections.push("# Transcript");

	// AI Summary section (only if available)
	if (data.metadata?.aiSummary) {
		sections.push("");
		sections.push("## AI Summary");
		sections.push("");
		const quotedLines = data.metadata.aiSummary
			.split("\n")
			.map(line => `> ${line}`)
			.join("\n");
		sections.push(quotedLines);
	}

	sections.push("");
	sections.push("## Full Transcript");
	sections.push("");

	if (data.lines.length === 0) {
		sections.push("*No transcript lines available.*");
		return sections.join("\n");
	}

	const isDiarized = data.metadata?.hasBeenDiarized === 1;

	if (isDiarized) {
		const blocks = groupBySpeaker(data.lines);
		for (const block of blocks) {
			const timestamp = formatTimestamp(block.startMs);
			if (block.speaker) {
				sections.push(`**${block.speaker}** [${timestamp}]`);
			} else {
				sections.push(`[${timestamp}]`);
			}
			sections.push(block.lines.join(" "));
			sections.push("");
		}
	} else {
		// Not diarized — just timestamped lines
		for (const line of data.lines) {
			const timestamp = formatTimestamp(line.startMs);
			sections.push(`[${timestamp}] ${line.text}`);
		}
		sections.push("");
	}

	return sections.join("\n");
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(folderPath);
	if (existing instanceof TFolder) return;
	try {
		await app.vault.createFolder(folderPath);
	} catch {
		// Folder may already exist (race condition)
	}
}

/**
 * Create a transcript markdown file from a MacWhisper session.
 * Returns the transcript file path on success, null if skipped.
 */
export async function createTranscriptFile(opts: {
	app: App;
	notePath: string;
	sessionId: string;
	transcriptFolderPath: string;
}): Promise<string | null> {
	const {app, notePath, sessionId, transcriptFolderPath} = opts;

	const transcriptPath = getTranscriptPath(notePath, transcriptFolderPath);

	// Idempotent — skip if file already exists
	if (app.vault.getAbstractFileByPath(transcriptPath) instanceof TFile) {
		return null;
	}

	const data = getTranscript(sessionId);

	// Skip if session not found
	if (!data.metadata) return null;

	await ensureFolder(app, transcriptFolderPath);

	const frontmatter = buildFrontmatter({
		notePath,
		sessionId,
		metadata: data.metadata,
		speakers: data.speakers,
	});

	const body = buildTranscriptBody(data);
	const content = `${frontmatter}\n\n${body}`;

	await app.vault.create(transcriptPath, content);

	// Update meeting note frontmatter with link to transcript
	const transcriptBasename = transcriptPath.split("/").pop()?.replace(/\.md$/, "") ?? "";
	await updateFrontmatter(app, notePath, "transcript", `[[${transcriptBasename}]]`);

	return transcriptPath;
}
