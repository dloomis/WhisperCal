import type {App} from "obsidian";
import type {ProposedSpeakerMapping} from "./SpeakerTagParser";
import {loadSidecar, VOICEPRINT_MODEL} from "./VoiceprintEnroller";
import {cosine, meanNorm} from "../utils/vec";

/**
 * Acoustic speaker matching. Matches each transcript speaker's centroid (from the
 * recording's Tome voiceprint sidecar) against the enrolled libraries in
 * Caches/Voiceprints. A confident match pre-fills the proposed name at CERTAIN —
 * acoustics beat a text guess for known people. Returns the per-speaker proposals so the
 * caller can detect a later user override and heal the library. No-op when the recording
 * has no sidecar or nothing is enrolled.
 *
 * Thresholds are conservative and may need tuning on the first real forward recordings:
 * libraries were seeded from mono-mix backfill, while live sidecars come from the cleaner
 * isolated system stream, so absolute cosines may shift. The margin-over-runner-up
 * requirement is the robust part (validation matches separated by 2-3x).
 */
const MATCH_THRESHOLD = 0.40; // min cosine similarity to the best library to accept
const MATCH_MARGIN = 0.08;    // best must beat the runner-up by at least this much

export interface VoiceprintMatch {
	name: string;
	cosine: number;
}

interface LibrarySummary {
	name: string;
	mean: number[];
}

/** Load every enrolled library, reduced to one normalized mean vector per person. */
async function loadLibraries(app: App, folder: string): Promise<LibrarySummary[]> {
	const out: LibrarySummary[] = [];
	try {
		if (!(await app.vault.adapter.exists(folder))) return out;
		const listing = await app.vault.adapter.list(folder);
		for (const path of listing.files) {
			if (!path.endsWith(".json")) continue;
			try {
				const lib = JSON.parse(await app.vault.adapter.read(path)) as {
					model?: string;
					name?: string;
					samples?: {embedding?: number[]}[];
				};
				if (lib.model !== VOICEPRINT_MODEL || !lib.name || !Array.isArray(lib.samples)) continue;
				const vecs = lib.samples
					.map(s => s.embedding)
					.filter((e): e is number[] => Array.isArray(e) && e.length > 0);
				if (vecs.length === 0) continue;
				out.push({name: lib.name, mean: meanNorm(vecs)});
			} catch {
				// skip an unreadable / malformed library file
			}
		}
	} catch {
		// folder missing or unreadable
	}
	return out;
}

/**
 * Match each mapping's speaker against the libraries and, on a confident hit, set
 * proposedName + CERTAIN on the mapping (overriding any prior LLM guess). Returns a map
 * of originalName → the match, for override detection / healing on apply.
 */
export async function matchVoiceprints(
	app: App,
	voiceprintFolderPath: string,
	transcriptPath: string,
	mappings: ProposedSpeakerMapping[],
): Promise<Map<string, VoiceprintMatch>> {
	const result = new Map<string, VoiceprintMatch>();
	const sidecar = await loadSidecar(app, transcriptPath);
	if (!sidecar) return result;
	const libs = await loadLibraries(app, voiceprintFolderPath);
	if (libs.length === 0) return result;

	for (const m of mappings) {
		const sp = sidecar.speakers[m.originalName];
		if (!sp || !Array.isArray(sp.embedding) || sp.embedding.length === 0) continue;

		let best = -1, second = -1, bestName = "";
		for (const lib of libs) {
			const c = cosine(sp.embedding, lib.mean);
			if (c > best) { second = best; best = c; bestName = lib.name; }
			else if (c > second) { second = c; }
		}

		if (best >= MATCH_THRESHOLD && best - second >= MATCH_MARGIN) {
			m.proposedName = bestName;
			m.confidence = "CERTAIN";
			m.evidence = `voiceprint match (cosine ${best.toFixed(3)})`;
			result.set(m.originalName, {name: bestName, cosine: best});
		}
	}
	return result;
}
