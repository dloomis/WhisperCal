import type {App} from "obsidian";
import {TFile} from "obsidian";
import type {SpeakerTagDecision} from "../ui/SpeakerTagModal";
import type {FrontmatterSpeaker} from "./SpeakerTagParser";
import {transcriptStartOffset} from "../utils/transcript";
import {PeopleMatchService} from "./PeopleMatchService";
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
	peopleFolderPath = "",
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(file instanceof TFile)) {
		throw new Error(`Transcript file not found: ${transcriptPath}`);
	}

	// Canonicalize typed names to the People-note basename so confirmed_speakers
	// wikilinks resolve (enrollment canonicalizes the same way — "Mike Johnson"
	// typed for note "Michael Johnson" must not produce a dangling link).
	const peopleSvc = peopleFolderPath ? new PeopleMatchService(app, peopleFolderPath) : null;
	const canonLink = (name: string): string => peopleSvc?.canonicalName(name) ?? name;

	// Build lookups from decisions. Match by speaker id (precise) and fall back to the
	// original/diarizer name — the embeddings-first path keys decisions off the body label,
	// which may not equal a pre-existing frontmatter id (e.g. a transcript first tagged under
	// the old LLM flow, where ids were MacWhisper hex).
	const decisionById = new Map<string, SpeakerTagDecision>();
	const decisionByName = new Map<string, SpeakerTagDecision>();
	for (const d of decisions) {
		if (d.speakerId) decisionById.set(d.speakerId, d);
		if (d.originalName) {
			// Keep the FIRST decision per name — a later duplicate label must not
			// silently steal the mapping (the id-based lookup above stays precise
			// either way; this map is only the no-id fallback).
			const key = d.originalName.toLowerCase();
			if (decisionByName.has(key)) {
				console.warn(`[WhisperCal] Duplicate speaker label "${d.originalName}" in decisions — name-based matching keeps the first`);
			} else {
				decisionByName.set(key, d);
			}
		}
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
				// Preserve the diarizer stub: set original_name only on the first tag. On a
				// re-tag review, speaker.name is already a real name, so overwriting would lose
				// the stub that voiceprint match/enroll key off.
				if (!speaker.original_name) speaker.original_name = speaker.name;
				speaker.name = decision.confirmedName;
				speaker.stub = false;
				if (decision.confidence) speaker.confidence = decision.confidence;
				if (decision.evidence) speaker.evidence = decision.evidence;
			}
		}

		// Build confirmed_speakers list — canonicalized and deduped (a split
		// diarizer cluster confirmed twice to one person is one entry).
		const confirmed: string[] = [];
		const confirmedSeen = new Set<string>();
		for (const d of decisions) {
			if (d.confirmedName) {
				const link = `[[${canonLink(d.confirmedName)}]]`;
				if (confirmedSeen.has(link)) continue;
				confirmedSeen.add(link);
				confirmed.push(link);
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
			// Rewrite only from the transcript heading down. The pipe-format
			// replacement ("John |") is a bare substring match, so running it over the
			// whole file would also rewrite YAML values, markdown table cells, and any
			// summary prose above the transcript that happens to contain the name.
			const start = transcriptStartOffset(content);
			const head = content.slice(0, start);
			let body = content.slice(start);
			// Two-pass replace via collision-proof sentinels: on re-tag reviews one
			// decision's confirmedName can equal another's originalName (swap/chain),
			// so direct sequential replacement would re-rewrite just-replaced labels.
			for (let i = 0; i < replacements.length; i++) {
				const {from} = replacements[i] as {from: string; to: string};
				body = body.split(`**${from}**`).join(`\0WCSPK${i}B\0`);
				body = body.split(`${from} |`).join(`\0WCSPK${i}P\0`);
			}
			for (let i = 0; i < replacements.length; i++) {
				const {to} = replacements[i] as {from: string; to: string};
				body = body.split(`\0WCSPK${i}B\0`).join(`**${to}**`);
				body = body.split(`\0WCSPK${i}P\0`).join(`${to} |`);
			}
			return head + body;
		});
	}
}
