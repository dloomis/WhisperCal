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
 * requirement is the robust part (validation matches separated by 2-3x). With a single
 * enrolled library there is no runner-up, so a stricter absolute floor (MATCH_THRESHOLD_SOLO)
 * stands in for the margin; centroids backed by very little speech are skipped entirely.
 */
// Default min cosine similarity to the best library to accept. User-overridable via the
// `voiceprintMatchFloor` setting (keep DEFAULT_SETTINGS.voiceprintMatchFloor in sync).
export const DEFAULT_MATCH_FLOOR = 0.50;
const MATCH_MARGIN = 0.08;    // best must beat the runner-up by at least this much
// With only one enrolled library the margin guard is inert (no runner-up to clear), so
// demand a stricter absolute similarity before trusting a solo match. The effective solo
// floor is never below the configured general floor (see matchVoiceprints).
const MATCH_THRESHOLD_SOLO = 0.55;
// Skip matching a centroid backed by less than this much diarized speech — too thin/noisy
// to trust a CERTAIN match against (mirrors the enroller's MIN_ENROLL_SECONDS).
const MATCH_MIN_SECONDS = 5;

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
 *
 * Mappings flagged `confirmed` (a re-review of an already-tagged transcript) are skipped
 * entirely: the user's prior decision is ground truth and must not be replaced by a fresh
 * acoustic guess. Library corrections on a re-review still flow through enroll/reconcile.
 */
export async function matchVoiceprints(
	app: App,
	voiceprintFolderPath: string,
	transcriptPath: string,
	mappings: ProposedSpeakerMapping[],
	matchFloor: number = DEFAULT_MATCH_FLOOR,
): Promise<Map<string, VoiceprintMatch>> {
	const result = new Map<string, VoiceprintMatch>();
	const sidecar = await loadSidecar(app, transcriptPath);
	if (!sidecar) return result;
	// Embeddings from different models live in different spaces — comparing a sidecar from
	// another model against these libraries would produce meaningless cosines. (The enroller
	// guards enrollment the same way.)
	if (sidecar.model !== VOICEPRINT_MODEL) {
		console.warn(`[WhisperCal] voiceprint sidecar model "${sidecar.model}" != "${VOICEPRINT_MODEL}" — skipping match`);
		return result;
	}
	const libs = await loadLibraries(app, voiceprintFolderPath);
	if (libs.length === 0) return result;

	// The solo case is the stricter of the two floors — never let it drop below the
	// configured general floor when the user raises that above MATCH_THRESHOLD_SOLO.
	const soloFloor = Math.max(matchFloor, MATCH_THRESHOLD_SOLO);

	for (const m of mappings) {
		// A name the user already confirmed wins over acoustics — don't re-derive or pre-fill
		// over it. Unconfirmed stubs and cached candidates are still matched below.
		if (m.confirmed) continue;
		const sp = sidecar.speakers[m.diarizerLabel || m.originalName];
		if (!sp || !Array.isArray(sp.embedding) || sp.embedding.length === 0) continue;
		if ((sp.activeSeconds ?? 0) < MATCH_MIN_SECONDS) continue;

		let best = -1, second = -1, bestName = "";
		for (const lib of libs) {
			const c = cosine(sp.embedding, lib.mean);
			if (c > best) { second = best; best = c; bestName = lib.name; }
			else if (c > second) { second = c; }
		}

		// second stays at its -1 sentinel when there is no usable runner-up (a single
		// library, or others that failed to compare) — fall back to the stricter solo floor.
		const floor = second > -1 ? matchFloor : soloFloor;
		if (best >= floor && best - second >= MATCH_MARGIN) {
			m.proposedName = bestName;
			m.confidence = "CERTAIN";
			m.source = "cache";
			m.evidence = `cosine ${best.toFixed(3)}`;
			result.set(m.originalName, {name: bestName, cosine: best});
		}
	}
	return result;
}
