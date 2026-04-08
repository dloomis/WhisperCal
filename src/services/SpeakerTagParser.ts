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

interface ParseResult {
	mappings: ProposedSpeakerMapping[];
	/** Explains why the result is empty/degraded, if applicable. */
	warning?: string;
}

export interface FrontmatterSpeaker {
	id?: string;
	name?: string;
	line_count?: number;
	stub?: boolean;
	original_name?: string;
	proposed_name?: string;
	confidence?: string;
	evidence?: string;
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

	// Try to extract a fenced JSON code block from the output
	const jsonResult = extractJsonSpeakers(stdout, speakers);
	if (jsonResult) return jsonResult;

	// Legacy fallback: try the old "Proposed Mapping:" regex format
	const legacyResult = extractLegacySpeakers(stdout, speakers);
	if (legacyResult) return legacyResult;

	// No parseable output — fallback to frontmatter speakers
	if (speakers.length === 0) {
		return {mappings: [], warning: "LLM returned no speaker mappings and transcript has no speakers"};
	}
	return {mappings: buildFallbackMappings(speakers)};
}

interface LlmSpeakerEntry {
	index: number;
	original_name: string;
	proposed_name: string | null;
	confidence: string | null;
	evidence: string;
}

function extractJsonSpeakers(
	stdout: string,
	speakers: FrontmatterSpeaker[],
): ParseResult | null {
	const jsonStart = stdout.indexOf("```json");
	if (jsonStart === -1) return null;
	const bodyStart = stdout.indexOf("\n", jsonStart);
	if (bodyStart === -1) return null;
	const jsonEnd = stdout.indexOf("```", bodyStart);
	if (jsonEnd === -1) return null;
	const jsonStr = stdout.slice(bodyStart, jsonEnd).trim();

	let parsed: {speakers?: LlmSpeakerEntry[]};
	try {
		parsed = JSON.parse(jsonStr) as {speakers?: LlmSpeakerEntry[]};
	} catch {
		console.warn("[WhisperCal] JSON block found but failed to parse");
		if (speakers.length === 0) {
			return {mappings: [], warning: "LLM output contained invalid JSON — no speakers found in transcript"};
		}
		return {
			mappings: buildFallbackMappings(speakers),
			warning: "LLM output contained invalid JSON — showing speakers without AI suggestions",
		};
	}

	if (!Array.isArray(parsed.speakers) || parsed.speakers.length === 0) {
		if (speakers.length === 0) {
			return {mappings: [], warning: "LLM JSON contained no speakers array"};
		}
		return {
			mappings: buildFallbackMappings(speakers),
			warning: "LLM JSON contained no speakers — showing speakers without AI suggestions",
		};
	}

	const llmMap = new Map<number, ProposedSpeakerMapping>();
	for (const entry of parsed.speakers) {
		const speaker = speakers[entry.index];
		llmMap.set(entry.index, {
			index: entry.index,
			originalName: entry.original_name,
			proposedName: entry.proposed_name ?? "",
			confidence: entry.confidence?.toUpperCase() ?? "",
			evidence: entry.evidence ?? "",
			speakerId: speaker?.id ?? "",
			lineCount: speaker?.line_count ?? 0,
		});
	}
	return {mappings: mergeWithFrontmatter(speakers, llmMap)};
}

/** Legacy fallback: parse the old "Proposed Mapping:" regex format. */
function extractLegacySpeakers(
	stdout: string,
	speakers: FrontmatterSpeaker[],
): ParseResult | null {
	const headerIdx = stdout.indexOf("Proposed Mapping:");
	if (headerIdx === -1) return null;

	const section = stdout.slice(headerIdx);
	const lineRe = /^- #(\d+):\s*"([^"]*?)"\s*→\s*(?:"([^"]*?)"|\(unresolved\))\s*\|\s*(\w*)\s*\|\s*(.*)$/gm;
	const llmMap = new Map<number, ProposedSpeakerMapping>();
	let match: RegExpExecArray | null;
	while ((match = lineRe.exec(section)) !== null) {
		const index = parseInt(match[1]!);
		const originalName = match[2]!;
		const proposedName = match[3] ?? "";
		const confidence = match[4] ?? "";
		const evidence = match[5]?.trim() ?? "";
		const speaker = speakers[index];
		llmMap.set(index, {
			index,
			originalName,
			proposedName,
			confidence: confidence.toUpperCase(),
			evidence,
			speakerId: speaker?.id ?? "",
			lineCount: speaker?.line_count ?? 0,
		});
	}
	if (llmMap.size > 0) {
		return {mappings: mergeWithFrontmatter(speakers, llmMap)};
	}

	console.warn("[WhisperCal] 'Proposed Mapping:' header found but no lines matched the expected format");
	if (speakers.length === 0) {
		return {mappings: [], warning: "LLM output was malformed — no speakers found in transcript"};
	}
	return {
		mappings: buildFallbackMappings(speakers),
		warning: "LLM output was malformed — showing speakers without AI suggestions",
	};
}

function mergeWithFrontmatter(
	speakers: FrontmatterSpeaker[],
	llmMap: Map<number, ProposedSpeakerMapping>,
): ProposedSpeakerMapping[] {
	// Build a name-based lookup from LLM entries so we match by speaker name
	// instead of array index — the LLM's numbering may differ from the
	// frontmatter order (e.g. alphabetical sort vs. speaker-label numbers).
	const llmByName = new Map<string, ProposedSpeakerMapping>();
	for (const mapping of llmMap.values()) {
		llmByName.set(mapping.originalName.toLowerCase(), mapping);
	}

	const merged: ProposedSpeakerMapping[] = [];
	const matched = new Set<string>();
	for (let i = 0; i < speakers.length; i++) {
		const s = speakers[i]!;
		const name = s.name ?? `Speaker ${i}`;
		const llm = llmByName.get(name.toLowerCase());
		if (llm) {
			// Re-index to frontmatter position and carry over speaker ID / line count
			merged.push({
				...llm,
				index: i,
				speakerId: s.id ?? llm.speakerId,
				lineCount: s.line_count ?? llm.lineCount,
			});
			matched.add(name.toLowerCase());
		} else {
			merged.push({
				index: i,
				originalName: name,
				proposedName: "",
				confidence: "",
				evidence: "",
				speakerId: s.id ?? "",
				lineCount: s.line_count ?? 0,
			});
		}
	}
	// Include any LLM entries that didn't match a frontmatter speaker by name
	for (const mapping of llmMap.values()) {
		if (!matched.has(mapping.originalName.toLowerCase())) {
			merged.push({...mapping, index: merged.length});
		}
	}
	return merged;
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

/**
 * Enrich mappings that have lineCount=0 by counting **SpeakerName** blocks
 * in the transcript body text. Useful when frontmatter lacks a speakers array
 * (e.g. Tome transcripts).
 */
export function enrichLineCountsFromBody(mappings: ProposedSpeakerMapping[], content: string): void {
	const counts = new Map<string, number>();
	const re = /^\*\*(.+?)\*\*/gm;
	let match: RegExpExecArray | null;
	while ((match = re.exec(content)) !== null) {
		const name = match[1]!;
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	for (const mapping of mappings) {
		if (mapping.lineCount === 0) {
			mapping.lineCount = counts.get(mapping.originalName) ?? 0;
		}
	}
}

/** Returns true if any speaker in the transcript frontmatter has a cached `proposed_name`. */
export function hasCachedProposals(app: App, transcriptPath: string): boolean {
	const speakers = getFrontmatterSpeakers(app, transcriptPath);
	return speakers.some(s => "proposed_name" in s);
}

/** Reconstruct ProposedSpeakerMapping[] from cached proposals on the attendees array. */
export function buildMappingsFromCache(app: App, transcriptPath: string): ProposedSpeakerMapping[] {
	const speakers = getFrontmatterSpeakers(app, transcriptPath);
	return speakers.map((s, i) => ({
		index: i,
		originalName: s.name ?? `Speaker ${i}`,
		proposedName: s.proposed_name ?? "",
		confidence: s.confidence ?? "",
		evidence: s.evidence ?? "",
		speakerId: s.id ?? "",
		lineCount: s.line_count ?? 0,
	}));
}

/**
 * Write LLM proposals onto the transcript's frontmatter attendees array.
 * If the attendees array exists, enriches entries (converting flat strings to objects).
 * If the attendees array is missing, creates it from the LLM mappings.
 */
export async function writeSpeakerProposals(
	app: App,
	transcriptPath: string,
	mappings: ProposedSpeakerMapping[],
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(file instanceof TFile)) return;

	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		const existing = frontmatter["attendees"];
		const proposalByName = new Map<string, ProposedSpeakerMapping>();
		for (const m of mappings) {
			proposalByName.set(m.originalName.toLowerCase(), m);
		}

		if (Array.isArray(existing) && existing.length > 0) {
			// Enrich existing attendees — convert flat strings to objects if needed
			frontmatter["attendees"] = existing.map((entry: unknown, i: number) => {
				const isObj = entry !== null && typeof entry === "object";
				const name = isObj ? (entry as FrontmatterSpeaker).name ?? `Speaker ${i}` : typeof entry === "string" ? entry : `Speaker ${i}`;
				const proposal = proposalByName.get(name.toLowerCase());
				if (isObj) {
					const speaker = entry as FrontmatterSpeaker;
					if (proposal) {
						speaker.proposed_name = proposal.proposedName;
						speaker.confidence = proposal.confidence;
						speaker.evidence = proposal.evidence;
					}
					return speaker;
				}
				return {
					name,
					id: proposal?.speakerId ?? "",
					stub: true,
					line_count: proposal?.lineCount ?? 0,
					proposed_name: proposal?.proposedName ?? "",
					confidence: proposal?.confidence ?? "",
					evidence: proposal?.evidence ?? "",
				};
			});
		} else {
			// No attendees — create from LLM mappings
			frontmatter["attendees"] = mappings.map(m => ({
				name: m.originalName,
				id: m.speakerId,
				stub: true,
				line_count: m.lineCount,
				proposed_name: m.proposedName,
				confidence: m.confidence,
				evidence: m.evidence,
			}));
		}
	});
}

/**
 * Strip cached proposal fields from all stub speakers.
 * Leaves name, id, stub, line_count intact for the next LLM run.
 */
export async function clearSpeakerProposals(app: App, transcriptPath: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(file instanceof TFile)) return;

	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		const attendees = frontmatter["attendees"];
		if (!Array.isArray(attendees)) return;
		for (const entry of attendees) {
			if (entry === null || typeof entry !== "object") continue;
			const speaker = entry as FrontmatterSpeaker;
			delete speaker.proposed_name;
			if (speaker.stub) {
				delete speaker.confidence;
				delete speaker.evidence;
			}
		}
	});
}

function getFrontmatterSpeakers(app: App, transcriptPath: string): FrontmatterSpeaker[] {
	const file = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(file instanceof TFile)) return [];
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return [];
	// Check attendees first (primary), then speakers (MacWhisper/TranscriptWriter)
	const arr: unknown = Array.isArray(fm["attendees"]) ? fm["attendees"] : fm["speakers"];
	if (!Array.isArray(arr)) return [];
	// Filter to objects only — flat strings and primitives are skipped
	return arr.filter((s): s is FrontmatterSpeaker =>
		s !== null && typeof s === "object" && !Array.isArray(s)
	);
}
