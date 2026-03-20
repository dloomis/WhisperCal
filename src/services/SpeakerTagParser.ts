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
): ProposedSpeakerMapping[] {
	const speakers = getFrontmatterSpeakers(app, transcriptPath);

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
		if (parsed.length > 0) return parsed;
	}

	// Fallback: build from frontmatter speakers with empty proposals
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
