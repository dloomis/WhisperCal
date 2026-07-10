import type {App} from "obsidian";
import {TFile, parseYaml} from "obsidian";
import type {SpeakerTagDecision} from "../ui/SpeakerTagModal";
import {FM} from "../constants";
import {ensureFolder, resolveWikiLink, stripWikiLink} from "../utils/vault";
import {sanitizeFilename} from "../utils/sanitize";
import {cosine, meanNorm} from "../utils/vec";
import {debug} from "../utils/debug";
import {PeopleMatchService} from "./PeopleMatchService";
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
	/** Libraries cleaned of a stale sample from this transcript after a corrected tag. */
	corrected: number;
	/** Enrolled names that did NOT resolve to a People note (kept as typed). The caller auto-creates
	 *  notes for these; any it deliberately skips (surname variants) are logged, not surfaced. */
	unmatchedPeople: string[];
	/** The transcript declared a `voiceprints:` sidecar, but it could not be resolved/loaded —
	 *  speakers were tagged but NOT acoustically enrolled. Surfaced to the user as a Notice so
	 *  the failure isn't silent. False when no sidecar was declared (a non-voiceprint transcript). */
	sidecarMissing: boolean;
}

/**
 * Read a transcript's frontmatter, preferring the metadata cache but falling back to a direct
 * disk read when the cache lacks the `voiceprints:` pointer. The cache can lag a just-written
 * transcript, and a recording-named sidecar (Call recordings) has no sibling-file backstop — so
 * without this fallback, enrollment right after Apply can silently no-op. Best-effort.
 */
async function readTranscriptFm(app: App, transcriptPath: string): Promise<Record<string, unknown>> {
	const file = app.vault.getAbstractFileByPath(transcriptPath);
	if (!(file instanceof TFile)) return {};
	const cached = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
	if (cached[FM.VOICEPRINTS] !== undefined) return cached;
	try {
		const content = await app.vault.read(file);
		const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (m && m[1]) {
			const parsed = parseYaml(m[1]) as Record<string, unknown> | null;
			if (parsed && typeof parsed === "object") {
				if (parsed[FM.VOICEPRINTS] !== undefined) {
					debug("voiceprint", "readTranscriptFm: voiceprints pointer recovered from disk (metadata cache lagged)");
				}
				return parsed;
			}
		}
	} catch (e) {
		debug("voiceprint", "readTranscriptFm: disk frontmatter read failed", e);
	}
	return cached;
}

/** True when the transcript's frontmatter declares a (non-empty) `voiceprints:` sidecar pointer. */
async function transcriptDeclaresVoiceprints(app: App, transcriptPath: string): Promise<boolean> {
	const raw = (await readTranscriptFm(app, transcriptPath))[FM.VOICEPRINTS];
	return typeof raw === "string" && raw.trim().length > 0;
}

/** Resolve and parse the voiceprint sidecar for a transcript, or null if absent/invalid. */
export async function loadSidecar(app: App, transcriptPath: string): Promise<VoiceprintSidecar | null> {
	const candidates: string[] = [];

	// Resolve the `voiceprints:` frontmatter pointer, so the sidecar can live wherever Tome
	// writes it (it's named after the recording, not the transcript).
	{
		const fm = await readTranscriptFm(app, transcriptPath);
		// 1. Obsidian link resolution — handles [[wikilinks]] and recognized attachment types.
		const linked = resolveWikiLink(app, fm, FM.VOICEPRINTS, transcriptPath);
		if (linked) candidates.push(linked.path);
		// 2. Path resolution of the raw value. Tome writes a bare ".voiceprints.json" filename,
		//    which Obsidian's link index does NOT resolve (".json" isn't a linkable extension),
		//    so resolve it as a path relative to the transcript's own folder, then vault root.
		const raw = fm[FM.VOICEPRINTS];
		if (typeof raw === "string" && raw.trim()) {
			const name = stripWikiLink(raw);
			const dir = transcriptPath.includes("/") ? transcriptPath.slice(0, transcriptPath.lastIndexOf("/")) : "";
			if (dir) candidates.push(`${dir}/${name}`);
			candidates.push(name);
		}
	}
	// 3. Fall back to the sibling convention (<transcript>.voiceprints.json).
	candidates.push(transcriptPath.replace(/\.md$/, ".voiceprints.json"));

	debug("voiceprint", `loadSidecar: transcript=${transcriptPath} candidates=`, candidates);

	for (const path of candidates) {
		try {
			if (!(await app.vault.adapter.exists(path))) {
				debug("voiceprint", `loadSidecar: candidate does not exist: ${path}`);
				continue;
			}
			const parsed = JSON.parse(await app.vault.adapter.read(path)) as VoiceprintSidecar;
			if (parsed && typeof parsed === "object" && parsed.speakers) {
				debug("voiceprint", `loadSidecar: RESOLVED ${path} (model=${parsed.model}, speakers=${Object.keys(parsed.speakers).join(", ")})`);
				return parsed;
			}
			debug("voiceprint", `loadSidecar: candidate parsed but has no speakers object: ${path}`);
		} catch (e) {
			debug("voiceprint", `loadSidecar: candidate failed to read/parse: ${path}`, e);
		}
	}
	debug("voiceprint", `loadSidecar: NO sidecar resolved for ${transcriptPath} — enrollment will be skipped`);
	return null;
}

/**
 * Delete an emptied library via fileManager.trashFile so it lands in the user's
 * configured trash (recoverable) instead of being removed permanently. Falls back
 * to adapter.remove only when the file isn't in the vault index yet.
 */
async function trashLibrary(app: App, path: string): Promise<void> {
	const af = app.vault.getAbstractFileByPath(path);
	if (af instanceof TFile) await app.fileManager.trashFile(af);
	else await app.vault.adapter.remove(path);
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
 * Enforce the per-(transcript, diarizer-label) invariant: every voiceprint sample from this
 * transcript must live ONLY in the library of the label's currently-confirmed speaker. Scans
 * every library and drops samples from `source` whose label is now confirmed to someone else
 * (or to no one — a cleared tag). This is what makes a corrected tag fix the library: changing
 * Speaker 2 from "Dave" to "Bill" removes Dave's stale sample here, and Bill's is (re-)added by
 * the enroll pass. Returns the number of libraries changed. Best-effort; never throws.
 */
async function reconcileTranscriptSamples(
	app: App,
	folder: string,
	source: string,
	labelToName: Map<string, string>,
): Promise<number> {
	let corrected = 0;
	try {
		if (!(await app.vault.adapter.exists(folder))) return 0;
		const listing = await app.vault.adapter.list(folder);
		for (const path of listing.files) {
			if (!path.endsWith(".json")) continue;
			const lib = await loadLibrary(app, path);
			if (!lib || !lib.name || lib.samples.length === 0) continue;
			const kept = lib.samples.filter(s =>
				s.source !== source || labelToName.get(s.originalLabel) === lib.name
			);
			if (kept.length === lib.samples.length) continue; // nothing from this transcript to move
			lib.samples = kept;
			try {
				if (lib.samples.length === 0) await trashLibrary(app, path);
				else await app.vault.adapter.write(path, JSON.stringify(lib, null, 2));
				corrected++;
				console.warn(`[WhisperCal] reconciled voiceprint "${lib.name}" — dropped a stale sample from ${source}`);
			} catch { /* skip an unwritable library */ }
		}
	} catch {
		// folder missing or unreadable — nothing to reconcile
	}
	return corrected;
}

/**
 * Enroll voiceprints from the user's confirmed speaker decisions. Best-effort and
 * idempotent (re-tagging the same transcript won't double-count). Never throws.
 */
export async function enrollVoiceprints(
	app: App,
	voiceprintFolderPath: string,
	peopleFolderPath: string,
	transcriptPath: string,
	decisions: SpeakerTagDecision[],
	today: string,
): Promise<EnrollResult> {
	const result: EnrollResult = {enrolled: [], skipped: 0, corrected: 0, unmatchedPeople: [], sidecarMissing: false};

	// Canonical identity = People-note basename, so the voiceprint library always aligns with the
	// People folder (the same target `confirmed_speakers` wikilinks resolve to). Names with no note
	// are kept as typed and reported in result.unmatchedPeople.
	const peopleSvc = new PeopleMatchService(app, peopleFolderPath);
	const matchedByName = new Map<string, boolean>();
	const canon = (raw: string): string => {
		const c = peopleSvc.canonicalName(raw);
		const name = c ?? raw;
		matchedByName.set(name, c !== null);
		if (c && c !== raw) debug("voiceprint", `  canonicalized "${raw}" -> "${c}" (People note)`);
		return name;
	};

	debug("voiceprint", `enrollVoiceprints: transcript=${transcriptPath}, folder=${voiceprintFolderPath}, decisions=`,
		decisions.map(d => ({confirmed: d.confirmedName, label: d.diarizerLabel || d.originalName})));

	const sidecar = await loadSidecar(app, transcriptPath);
	if (!sidecar) {
		// Flag only when a sidecar was actually declared — a missing-but-expected sidecar means
		// speakers were tagged but couldn't be enrolled (the caller surfaces a Notice). A transcript
		// with no `voiceprints:` pointer is simply not a voiceprint transcript — stay quiet.
		result.sidecarMissing = await transcriptDeclaresVoiceprints(app, transcriptPath);
		debug("voiceprint", result.sidecarMissing
			? "enrollVoiceprints: voiceprints sidecar declared but could NOT be resolved — speakers tagged, not enrolled"
			: "enrollVoiceprints: no voiceprints sidecar declared for this transcript — nothing to enroll");
		return result;
	}
	if (sidecar.model !== VOICEPRINT_MODEL) {
		console.warn(`[WhisperCal] voiceprint sidecar model "${sidecar.model}" != "${VOICEPRINT_MODEL}" — skipping enrollment`);
		debug("voiceprint", `enrollVoiceprints: sidecar model mismatch (${sidecar.model} != ${VOICEPRINT_MODEL}) — nothing enrolled`);
		return result;
	}
	debug("voiceprint", `enrollVoiceprints: sidecar OK, available speaker labels=${Object.keys(sidecar.speakers).join(", ")}`);

	const source = transcriptPath.includes("/") ? transcriptPath.slice(transcriptPath.lastIndexOf("/") + 1) : transcriptPath;

	// Reconcile first so a corrected tag fixes the library: this transcript's sample for each
	// diarizer label must live only in that label's currently-confirmed speaker. Runs even when
	// nothing new enrolls (e.g. a tag was cleared), so stale samples are always pruned.
	const labelToName = new Map<string, string>();
	for (const d of decisions) {
		const nm = d.confirmedName?.trim();
		const label = d.diarizerLabel || d.originalName;
		if (nm && label) labelToName.set(label, canon(nm));
	}
	result.corrected = await reconcileTranscriptSamples(app, voiceprintFolderPath, source, labelToName);

	// A person may hold more than one diarizer label (a split cluster) — collect all.
	const pending = new Map<string, VoiceprintSample[]>();
	for (const d of decisions) {
		const raw = d.confirmedName?.trim();
		if (!raw) { debug("voiceprint", `  decision skipped: no confirmed name (label=${d.diarizerLabel || d.originalName})`); continue; }
		const name = canon(raw);
		// Sidecar key is the diarizer stub. On a first tag originalName IS the stub; on a re-tag
		// review originalName is the real-name body label, so use the explicit diarizerLabel.
		const label = d.diarizerLabel || d.originalName;
		const sp = sidecar.speakers[label];
		if (!sp || !Array.isArray(sp.embedding) || sp.embedding.length === 0) {
			debug("voiceprint", `  "${name}" SKIP: sidecar has no embedding for label "${label}" (sidecar labels: ${Object.keys(sidecar.speakers).join(", ")})`);
			result.skipped++; continue;
		}
		if ((sp.activeSeconds ?? 0) < MIN_ENROLL_SECONDS) {
			debug("voiceprint", `  "${name}" SKIP: label "${label}" has only ${sp.activeSeconds}s active speech (< ${MIN_ENROLL_SECONDS}s floor)`);
			result.skipped++; continue;
		}
		debug("voiceprint", `  "${name}" ENROLL candidate: label="${label}", activeSeconds=${sp.activeSeconds}, dim=${sp.embedding.length}`);
		const list = pending.get(name) ?? [];
		list.push({embedding: sp.embedding, source, originalLabel: label, activeSeconds: sp.activeSeconds ?? 0, date: today});
		pending.set(name, list);
	}
	// People with a pending sample but no People note — kept as typed, flagged for the caller.
	result.unmatchedPeople = [...pending.keys()].filter(n => matchedByName.get(n) === false);
	debug("voiceprint", `enrollVoiceprints: ${pending.size} name(s) to enroll, ${result.skipped} skipped, ${result.corrected} reconciled, unmatched=[${result.unmatchedPeople.join(", ")}]`);
	if (pending.size === 0) return result;

	await ensureFolder(app, voiceprintFolderPath);

	for (const [name, samples] of pending) {
		const path = `${voiceprintFolderPath}/${sanitizeFilename(name)}.json`;
		try {
			const existing = await loadLibrary(app, path);
			const lib: VoiceprintLibrary = existing && existing.model === VOICEPRINT_MODEL
				? existing
				: {schema: 1, model: VOICEPRINT_MODEL, name, samples: []};
			debug("voiceprint", `  "${name}": ${existing ? `existing library (${existing.samples.length} samples)` : "new library"} at ${path}`);

			const seen = new Set(lib.samples.map(s => `${s.source}#${s.originalLabel}`));
			const existingMean = lib.samples.length >= 2 ? meanNorm(lib.samples.map(s => s.embedding)) : null;
			let added = false;
			for (const s of samples) {
				const key = `${s.source}#${s.originalLabel}`;
				if (seen.has(key)) {
					debug("voiceprint", `    sample ${key} already present — dedup skip`);
					continue;
				}
				// Guard against a mis-confirmation poisoning the library: a sample that looks
				// nothing like this person's existing voice is almost certainly the wrong
				// speaker. (Skipped for thin libraries — no baseline yet.)
				if (existingMean && cosine(s.embedding, existingMean) < ENROLL_OUTLIER_FLOOR) {
					console.warn(`[WhisperCal] skipping outlier voiceprint sample for "${name}"`);
					debug("voiceprint", `    sample ${key} OUTLIER (cosine ${cosine(s.embedding, existingMean).toFixed(3)} < ${ENROLL_OUTLIER_FLOOR}) — skipped`);
					continue;
				}
				seen.add(key);
				lib.samples.push(s);
				added = true;
				debug("voiceprint", `    sample ${key} added`);
			}
			if (!added) { debug("voiceprint", `  "${name}": no new samples added — not writing`); continue; }

			if (lib.samples.length > MAX_SAMPLES_PER_PERSON) {
				lib.samples.sort((a, b) => b.activeSeconds - a.activeSeconds);
				lib.samples = lib.samples.slice(0, MAX_SAMPLES_PER_PERSON);
			}
			await app.vault.adapter.write(path, JSON.stringify(lib, null, 2));
			result.enrolled.push(name);
			debug("voiceprint", `  "${name}": WROTE ${path} (${lib.samples.length} samples total)`);
		} catch (e) {
			console.warn(`[WhisperCal] failed to enroll voiceprint for "${name}"`, e);
			debug("voiceprint", `  "${name}": write FAILED`, e);
		}
	}
	debug("voiceprint", `enrollVoiceprints: done — enrolled=[${result.enrolled.join(", ")}], skipped=${result.skipped}, corrected=${result.corrected}`);
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
		const confirmed = d.confirmedName?.trim();
		if (!confirmed) continue;                           // cleared/skipped — not a "wrong match" signal
		if (confirmed === proposed) continue;               // match accepted — nothing to heal
		const sp = sidecar.speakers[d.diarizerLabel || d.originalName];
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
		if (lib.samples.length === 0) await trashLibrary(app, path);
		else await app.vault.adapter.write(path, JSON.stringify(lib, null, 2));
	} catch {
		return false;
	}
	console.warn(`[WhisperCal] healed voiceprint "${name}" — removed a sample that caused a false match`);
	return true;
}
