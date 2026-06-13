import type {App} from "obsidian";
import {TFile} from "obsidian";
import type {SpeakerTagDecision} from "../ui/SpeakerTagModal";
import {FM} from "../constants";
import {ensureFolder, resolveWikiLink} from "../utils/vault";
import {sanitizeFilename} from "../utils/sanitize";
import {cosine, meanNorm} from "../utils/vec";
import type {VoiceprintMatch} from "./VoiceprintMatcher";

/**
 * Acoustic speaker enrollment. When the user applies speaker tags to a transcript
 * that has a Tome voiceprint sidecar (`<transcript>.voiceprints.json`), bind each
 * confirmed name to that speaker's centroid embedding and append it as a sample to
 * `<voiceprintFolder>/<Name>.json`. The Apply click is the trust signal — over a few
 * meetings each regular self-enrolls with no extra work. Phase 3 will match new
 * recordings against these libraries before invoking the LLM.
 *
 * See docs/voiceprints.md (Tome repo) for the producer side and the binding contract.
 */

/** Embedding-space identity. MUST match Tome's `VoiceprintSidecar.modelIdentity`.
 *  Embeddings from different models live in different spaces — never compare/merge them. */
export const VOICEPRINT_MODEL = "speakerkit-1.0";
/** Skip a centroid backed by less than this much diarized speech (thin/unreliable). */
const MIN_ENROLL_SECONDS = 5;
/** Keep at most this many samples per person; longest-speech samples win. */
const MAX_SAMPLES_PER_PERSON = 12;
/** A new sample this far below a person's existing mean is treated as a mis-confirmation. */
const ENROLL_OUTLIER_FLOOR = 0.30;
/** On a corrected false match, only remove a culprit at least this similar to the speaker. */
const HEAL_SIM_FLOOR = 0.40;
/** ...and only if it's this much of an outlier within the wrongly-matched library. */
const HEAL_OUTLIER_MAX = 0.55;

export interface SidecarSpeaker {
	embedding: number[];
	activeSeconds: number;
	segmentCount: number;
}
export interface VoiceprintSidecar {
	schema: number;
	model: string;
	dimension: number;
	source: string;
	includesYou: boolean;
	speakers: Record<string, SidecarSpeaker>;
}

interface VoiceprintSample {
	embedding: number[];
	/** Transcript filename the centroid came from (dedupe key with originalLabel). */
	source: string;
	/** Diarizer label the centroid had, e.g. "Speaker 2". */
	originalLabel: string;
	activeSeconds: number;
	/** ISO date (YYYY-MM-DD) the sample was enrolled. */
	date: string;
}
interface VoiceprintLibrary {
	schema: number;
	model: string;
	name: string;
	samples: VoiceprintSample[];
}

export interface EnrollResult {
	/** Names that received a new sample. */
	enrolled: string[];
	/** Confirmed labels skipped (no sidecar entry, too short, etc.). */
	skipped: number;
}

/** Resolve and parse the voiceprint sidecar for a transcript, or null if absent/invalid. */
export async function loadSidecar(app: App, transcriptPath: string): Promise<VoiceprintSidecar | null> {
	const candidates: string[] = [];

	// Prefer the `voiceprints:` frontmatter pointer — resolved by name anywhere in the
	// vault (Obsidian link resolution), so the sidecar can live in whatever folder Tome
	// writes it to, not just next to the transcript.
	const file = app.vault.getAbstractFileByPath(transcriptPath);
	if (file instanceof TFile) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const linked = resolveWikiLink(app, fm, FM.VOICEPRINTS, transcriptPath);
		if (linked) candidates.push(linked.path);
	}
	// Fall back to the sibling convention.
	candidates.push(transcriptPath.replace(/\.md$/, ".voiceprints.json"));

	for (const path of candidates) {
		try {
			if (!(await app.vault.adapter.exists(path))) continue;
			const parsed = JSON.parse(await app.vault.adapter.read(path)) as VoiceprintSidecar;
			if (parsed && typeof parsed === "object" && parsed.speakers) return parsed;
		} catch {
			// try the next candidate
		}
	}
	return null;
}

async function loadLibrary(app: App, path: string): Promise<VoiceprintLibrary | null> {
	try {
		if (!(await app.vault.adapter.exists(path))) return null;
		const parsed = JSON.parse(await app.vault.adapter.read(path)) as VoiceprintLibrary;
		return parsed && Array.isArray(parsed.samples) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Enroll voiceprints from the user's confirmed speaker decisions. Best-effort and
 * idempotent (re-tagging the same transcript won't double-count). Never throws.
 */
export async function enrollVoiceprints(
	app: App,
	voiceprintFolderPath: string,
	transcriptPath: string,
	decisions: SpeakerTagDecision[],
	today: string,
): Promise<EnrollResult> {
	const result: EnrollResult = {enrolled: [], skipped: 0};

	const sidecar = await loadSidecar(app, transcriptPath);
	if (!sidecar) return result;
	if (sidecar.model !== VOICEPRINT_MODEL) {
		console.warn(`[WhisperCal] voiceprint sidecar model "${sidecar.model}" != "${VOICEPRINT_MODEL}" — skipping enrollment`);
		return result;
	}

	const source = transcriptPath.includes("/") ? transcriptPath.slice(transcriptPath.lastIndexOf("/") + 1) : transcriptPath;

	// A person may hold more than one diarizer label (a split cluster) — collect all.
	const pending = new Map<string, VoiceprintSample[]>();
	for (const d of decisions) {
		const name = d.confirmedName?.trim();
		if (!name) continue;
		const sp = sidecar.speakers[d.originalName];
		if (!sp || !Array.isArray(sp.embedding) || sp.embedding.length === 0) { result.skipped++; continue; }
		if ((sp.activeSeconds ?? 0) < MIN_ENROLL_SECONDS) { result.skipped++; continue; }
		const list = pending.get(name) ?? [];
		list.push({embedding: sp.embedding, source, originalLabel: d.originalName, activeSeconds: sp.activeSeconds ?? 0, date: today});
		pending.set(name, list);
	}
	if (pending.size === 0) return result;

	await ensureFolder(app, voiceprintFolderPath);

	for (const [name, samples] of pending) {
		const path = `${voiceprintFolderPath}/${sanitizeFilename(name)}.json`;
		try {
			const existing = await loadLibrary(app, path);
			const lib: VoiceprintLibrary = existing && existing.model === VOICEPRINT_MODEL
				? existing
				: {schema: 1, model: VOICEPRINT_MODEL, name, samples: []};

			const seen = new Set(lib.samples.map(s => `${s.source}#${s.originalLabel}`));
			const existingMean = lib.samples.length >= 2 ? meanNorm(lib.samples.map(s => s.embedding)) : null;
			let added = false;
			for (const s of samples) {
				const key = `${s.source}#${s.originalLabel}`;
				if (seen.has(key)) continue;
				// Guard against a mis-confirmation poisoning the library: a sample that looks
				// nothing like this person's existing voice is almost certainly the wrong
				// speaker. (Skipped for thin libraries — no baseline yet.)
				if (existingMean && cosine(s.embedding, existingMean) < ENROLL_OUTLIER_FLOOR) {
					console.warn(`[WhisperCal] skipping outlier voiceprint sample for "${name}"`);
					continue;
				}
				seen.add(key);
				lib.samples.push(s);
				added = true;
			}
			if (!added) continue;

			if (lib.samples.length > MAX_SAMPLES_PER_PERSON) {
				lib.samples.sort((a, b) => b.activeSeconds - a.activeSeconds);
				lib.samples = lib.samples.slice(0, MAX_SAMPLES_PER_PERSON);
			}
			await app.vault.adapter.write(path, JSON.stringify(lib, null, 2));
			result.enrolled.push(name);
		} catch (e) {
			console.warn(`[WhisperCal] failed to enroll voiceprint for "${name}"`, e);
		}
	}
	return result;
}

/**
 * Self-heal on a corrected false match. When voiceprint matching proposed a name the user
 * then overrode, that speaker's centroid should NOT have matched that person — so remove
 * the culprit sample (the one in that person's library most similar to this speaker), but
 * only when it's a genuine outlier-poison (very similar to this speaker AND a poor fit for
 * its own library), so two genuinely similar voices don't cost a legit sample. Returns the
 * number of libraries healed. Best-effort; never throws.
 */
export async function healVoiceprints(
	app: App,
	voiceprintFolderPath: string,
	transcriptPath: string,
	decisions: SpeakerTagDecision[],
	proposals: Map<string, VoiceprintMatch>,
): Promise<number> {
	if (proposals.size === 0) return 0;
	const sidecar = await loadSidecar(app, transcriptPath);
	if (!sidecar) return 0;

	let healed = 0;
	for (const d of decisions) {
		const proposed = proposals.get(d.originalName)?.name;
		if (!proposed) continue;                            // not a voiceprint match
		if (d.confirmedName?.trim() === proposed) continue; // match accepted — nothing to heal
		const sp = sidecar.speakers[d.originalName];
		if (!sp || !Array.isArray(sp.embedding) || sp.embedding.length === 0) continue;
		if (await removeCulpritSample(app, voiceprintFolderPath, proposed, sp.embedding)) healed++;
	}
	return healed;
}

async function removeCulpritSample(app: App, folder: string, name: string, centroid: number[]): Promise<boolean> {
	const path = `${folder}/${sanitizeFilename(name)}.json`;
	const lib = await loadLibrary(app, path);
	if (!lib || lib.samples.length === 0) return false;

	let idx = -1, bestSim = -1;
	for (let i = 0; i < lib.samples.length; i++) {
		const c = cosine(lib.samples[i]!.embedding, centroid);
		if (c > bestSim) { bestSim = c; idx = i; }
	}
	if (idx < 0 || bestSim < HEAL_SIM_FLOOR) return false; // nothing here actually resembles the speaker

	const others = lib.samples.filter((_, i) => i !== idx).map(s => s.embedding);
	const isOutlier = others.length === 0 || cosine(lib.samples[idx]!.embedding, meanNorm(others)) < HEAL_OUTLIER_MAX;
	if (!isOutlier && lib.samples.length > 2) return false; // a legit sample of a genuinely similar voice — keep it

	lib.samples.splice(idx, 1);
	try {
		if (lib.samples.length === 0) await app.vault.adapter.remove(path);
		else await app.vault.adapter.write(path, JSON.stringify(lib, null, 2));
	} catch {
		return false;
	}
	console.warn(`[WhisperCal] healed voiceprint "${name}" — removed a sample that caused a false match`);
	return true;
}
