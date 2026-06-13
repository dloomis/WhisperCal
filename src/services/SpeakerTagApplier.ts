import type {App} from "obsidian";
import {TFile} from "obsidian";
import type {SpeakerTagDecision} from "../ui/SpeakerTagModal";
import type {FrontmatterSpeaker} from "./SpeakerTagParser";
import {FM} from "../constants";

/**
 * Apply approved speaker tag decisions to the transcript file:
 * 1. Update frontmatter speakers array + pipeline_state + confirmed_speakers
 * 2. Replace stub labels in the body text
 *
 * Throws on file-not-found or write failures so the caller can show a Notice.
 */
export async function applySpeakerTags(
	app: App,
	transcriptPath: string,
	decisions: SpeakerTagDecision[],
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(file instanceof TFile)) {
		throw new Error(`Transcript file not found: ${transcriptPath}`);
	}

	// Build lookups from decisions. Match by speaker id (precise) and fall back to the
	// original/diarizer name — the embeddings-first path keys decisions off the body label,
	// which may not equal a pre-existing frontmatter id (e.g. a transcript first tagged under
	// the old LLM flow, where ids were MacWhisper hex).
	const decisionById = new Map<string, SpeakerTagDecision>();
	const decisionByName = new Map<string, SpeakerTagDecision>();
	for (const d of decisions) {
		if (d.speakerId) decisionById.set(d.speakerId, d);
		if (d.originalName) decisionByName.set(d.originalName.toLowerCase(), d);
	}

	// 1. Update frontmatter
	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		const attendees = frontmatter["attendees"] ?? frontmatter["speakers"];
		if (Array.isArray(attendees)) {
			for (const speaker of attendees as FrontmatterSpeaker[]) {
				delete speaker.proposed_name;
				// Read speaker.name before any rename below — it's still the original label here.
				const decision = (speaker.id ? decisionById.get(speaker.id) : undefined)
					?? (speaker.name ? decisionByName.get(speaker.name.toLowerCase()) : undefined);
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
			frontmatter[FM.CONFIRMED_SPEAKERS] = confirmed;
		}

		frontmatter[FM.PIPELINE_STATE] = "tagged";
	});

	// 2. Replace stub labels in body text
	// Verify file still exists after frontmatter update
	const fileCheck = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(fileCheck instanceof TFile)) {
		throw new Error(`Transcript file was deleted during processing: ${transcriptPath}`);
	}

	// Collect replacements, process longer names first to avoid substring collisions
	const replacements: Array<{from: string; to: string}> = [];
	for (const d of decisions) {
		if (d.confirmedName && d.originalName !== d.confirmedName) {
			replacements.push({from: d.originalName, to: d.confirmedName});
		}
	}
	replacements.sort((a, b) => b.from.length - a.from.length);

	if (replacements.length > 0) {
		await app.vault.process(fileCheck, (content) => {
			// Split into frontmatter and body to avoid corrupting YAML values
			const fmEnd = content.indexOf("\n---", 1);
			if (fmEnd === -1) return content;
			const bodyStart = content.indexOf("\n", fmEnd + 4);
			if (bodyStart === -1) return content;
			const head = content.slice(0, bodyStart);
			let body = content.slice(bodyStart);
			for (const {from, to} of replacements) {
				// Replace **Original** → **Confirmed**
				body = body.split(`**${from}**`).join(`**${to}**`);
				// Replace "Original |" → "Confirmed |" (pipe-delimited format)
				body = body.split(`${from} |`).join(`${to} |`);
			}
			return head + body;
		});
	}
}
