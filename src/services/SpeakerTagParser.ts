import type {App} from "obsidian";
import {TFile} from "obsidian";

export interface ProposedSpeakerMapping {
	index: number;
	originalName: string;
	proposedName: string;
	confidence: string;
	evidence: string;
	speakerId: string;
	lineCount: number;
}

export interface ParseResult {
	mappings: ProposedSpeakerMapping[];
	/** Explains why the result is empty/degraded, if applicable. */
	warning?: string;
}

interface FrontmatterSpeaker {
	id?: string;
	name?: string;
	line_count?: number;
	stub?: boolean;
}

/**
 * Parse batch-mode LLM output into proposed speaker mappings,
 * cross-referenced with the transcript's frontmatter speakers array.
 */
export function parseSpeakerTagOutput(
	stdout: string,
	app: App,
	transcriptPath: string,
): ParseResult {
	const speakers = getFrontmatterSpeakers(app, transcriptPath);

	// Empty or whitespace-only output
	if (!stdout.trim()) {
		if (speakers.length === 0) {
			return {mappings: [], warning: "LLM returned no output and transcript has no speakers"};
		}
		return {
			mappings: buildFallbackMappings(speakers),
			warning: "LLM returned no output — showing speakers without AI suggestions",
		};
	}

	// Try to find and parse the structured "Proposed Mapping:" section
	const headerIdx = stdout.indexOf("Proposed Mapping:");
	if (headerIdx !== -1) {
		const section = stdout.slice(headerIdx);
		// Match lines like: - #0: "Microphone" → "Jane Smith" | CERTAIN | microphone user
		// or: - #0: "Speaker 1" → (unresolved) | | no evidence
		const lineRe = /^- #(\d+):\s*"([^"]*?)"\s*→\s*(?:"([^"]*?)"|\(unresolved\))\s*\|\s*(\w*)\s*\|\s*(.*)$/gm;
		const parsed: ProposedSpeakerMapping[] = [];
		let match: RegExpExecArray | null;
		while ((match = lineRe.exec(section)) !== null) {
			const index = parseInt(match[1]!);
			const originalName = match[2]!;
			const proposedName = match[3] ?? "";
			const confidence = match[4] ?? "";
			const evidence = match[5]?.trim() ?? "";
			const speaker = speakers[index];
			parsed.push({
				index,
				originalName,
				proposedName,
				confidence: confidence.toUpperCase(),
				evidence,
				speakerId: speaker?.id ?? "",
				lineCount: speaker?.line_count ?? 0,
			});
		}
		if (parsed.length > 0) return {mappings: parsed};

		// Header found but no lines parsed — malformed output
		console.warn("[WhisperCal] 'Proposed Mapping:' header found but no lines matched the expected format");
		if (speakers.length === 0) {
			return {mappings: [], warning: "LLM output was malformed — no speakers found in transcript"};
		}
		return {
			mappings: buildFallbackMappings(speakers),
			warning: "LLM output was malformed — showing speakers without AI suggestions",
		};
	}

	// No header at all — fallback to frontmatter speakers
	if (speakers.length === 0) {
		return {mappings: [], warning: "LLM returned no speaker mappings and transcript has no speakers"};
	}
	return {mappings: buildFallbackMappings(speakers)};
}

function buildFallbackMappings(speakers: FrontmatterSpeaker[]): ProposedSpeakerMapping[] {
	return speakers.map((s, i) => ({
		index: i,
		originalName: s.name ?? `Speaker ${i}`,
		proposedName: "",
		confidence: "",
		evidence: "",
		speakerId: s.id ?? "",
		lineCount: s.line_count ?? 0,
	}));
}

function getFrontmatterSpeakers(app: App, transcriptPath: string): FrontmatterSpeaker[] {
	const file = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(file instanceof TFile)) return [];
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return [];
	const speakers: unknown = fm["speakers"];
	if (!Array.isArray(speakers)) return [];
	return speakers as FrontmatterSpeaker[];
}
