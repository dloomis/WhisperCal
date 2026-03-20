import type {App} from "obsidian";
import {TFile} from "obsidian";
import type {SpeakerTagDecision} from "../ui/SpeakerTagModal";

interface FrontmatterSpeaker {
	id?: string;
	name?: string;
	stub?: boolean;
	line_count?: number;
	original_name?: string;
	confidence?: string;
	evidence?: string;
}

/**
 * Apply approved speaker tag decisions to the transcript file:
 * 1. Update frontmatter speakers array + pipeline_state + confirmed_speakers
 * 2. Replace stub labels in the body text
 */
export async function applySpeakerTags(
	app: App,
	transcriptPath: string,
	decisions: SpeakerTagDecision[],
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(file instanceof TFile)) return;

	// Build lookup from speakerId to decision
	const decisionMap = new Map<string, SpeakerTagDecision>();
	for (const d of decisions) {
		if (d.speakerId) decisionMap.set(d.speakerId, d);
	}

	// 1. Update frontmatter
	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		const speakers = frontmatter["speakers"];
		if (Array.isArray(speakers)) {
			for (const speaker of speakers as FrontmatterSpeaker[]) {
				const decision = speaker.id ? decisionMap.get(speaker.id) : undefined;
				if (!decision || !decision.confirmedName) continue;
				speaker.original_name = speaker.name;
				speaker.name = decision.confirmedName;
				speaker.stub = false;
				if (decision.confidence) speaker.confidence = decision.confidence;
				if (decision.evidence) speaker.evidence = decision.evidence;
			}
		}

		// Build confirmed_speakers list
		const confirmed: string[] = [];
		for (const d of decisions) {
			if (d.confirmedName) {
				confirmed.push(`[[${d.confirmedName}]]`);
			}
		}
		if (confirmed.length > 0) {
			frontmatter["confirmed_speakers"] = confirmed;
		}

		frontmatter["pipeline_state"] = "tagged";
	});

	// 2. Replace stub labels in body text
	// Collect replacements, process longer names first to avoid substring collisions
	const replacements: Array<{from: string; to: string}> = [];
	for (const d of decisions) {
		if (d.confirmedName && d.originalName !== d.confirmedName) {
			replacements.push({from: d.originalName, to: d.confirmedName});
		}
	}
	replacements.sort((a, b) => b.from.length - a.from.length);

	if (replacements.length > 0) {
		await app.vault.process(file, (content) => {
			for (const {from, to} of replacements) {
				// Replace **Original** → **Confirmed**
				content = content.split(`**${from}**`).join(`**${to}**`);
				// Replace "Original |" → "Confirmed |" (pipe-delimited format)
				content = content.split(`${from} |`).join(`${to} |`);
			}
			return content;
		});
	}
}
