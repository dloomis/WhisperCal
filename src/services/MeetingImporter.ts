import {App, FileSystemAdapter, Notice, TFile, normalizePath, parseYaml} from "obsidian";
import {promises as fs} from "fs";
import {join} from "path";
import {homedir} from "os";
import {unzip, type Unzipped} from "fflate";
import type {WhisperCalSettings} from "../settings";
import {FM} from "../constants";
import {ensureFolder} from "../utils/vault";
import {yamlEscape} from "../utils/sanitize";
import {remoteDialog} from "../utils/electron";

/** A markdown member of the bundle: frontmatter both parsed (to read) and raw (to edit). */
interface BundleDoc {
	fm: Record<string, unknown>;
	rawFm: string;
	body: string;
	basename: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/;
const FM_KEY_RE = /^([A-Za-z_][\w-]*)\s*:/;

/**
 * Split a markdown file into its frontmatter — kept both parsed (for reading)
 * and verbatim (for editing) — and the body after it. Returns null for a file
 * with no frontmatter block, unparseable YAML, or a non-mapping document, none
 * of which can be a bundle member.
 */
function splitFrontmatter(text: string): {fm: Record<string, unknown>; rawFm: string; body: string} | null {
	const m = FRONTMATTER_RE.exec(text);
	if (!m?.[1]) return null;
	let parsed: unknown;
	try {
		parsed = parseYaml(m[1]);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return {fm: parsed as Record<string, unknown>, rawFm: m[1], body: text.slice(m[0].length)};
}

/**
 * Rewrite selected keys in a frontmatter block by line surgery, leaving every
 * other line byte-identical. A key not already in the block is appended.
 *
 * Deliberately not a parse/mutate/re-emit round-trip. A bundle comes from
 * another WhisperCal vault, so its frontmatter already has our shape and only a
 * key or two needs to change — re-emitting the whole block would let the YAML
 * writer restyle values the rest of the pipeline matches on as raw strings.
 * `meeting_date: "2026-07-10"` re-emitted bare re-reads as a Date, and findNote
 * compares it with ===, so the note would render a card that could never
 * resolve back to it.
 */
function editFrontmatter(raw: string, updates: Record<string, string>): string {
	const pending = new Map(Object.entries(updates));
	const lines = raw.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const key = FM_KEY_RE.exec(line)?.[1];
		if (key === undefined || !pending.has(key)) {
			out.push(line);
			continue;
		}
		out.push(`${key}: ${pending.get(key)!}`);
		pending.delete(key);
	}
	for (const [key, value] of pending) out.push(`${key}: ${value}`);
	return out.join("\n");
}

function joinFrontmatter(rawFm: string, body: string): string {
	return `---\n${rawFm}\n---\n${body}`;
}

/** Frontmatter `tags` is a list from the plugin's own writers but a scalar from some templates. */
function hasTag(fm: Record<string, unknown>, tag: string): boolean {
	const tags = fm["tags"];
	return Array.isArray(tags) ? tags.includes(tag) : tags === tag;
}

function isTranscriptDoc(fm: Record<string, unknown>): boolean {
	return hasTag(fm, "transcript") || fm[FM.MEETING_NOTE] !== undefined;
}

function isNoteDoc(fm: Record<string, unknown>): boolean {
	return hasTag(fm, "meeting") || fm[FM.CALENDAR_EVENT_ID] !== undefined;
}

/**
 * Ask for a bundle via the system picker. Returns null when the user cancels.
 * Unlike export there's no fallback to offer: a destination folder has an
 * obvious default, a source file doesn't.
 */
async function pickBundle(): Promise<string | null> {
	const dialog = remoteDialog();
	if (!dialog) {
		new Notice("System file picker unavailable — can't choose a bundle");
		return null;
	}
	try {
		const result = await dialog.showOpenDialog({
			title: "Choose a meeting bundle",
			buttonLabel: "Import",
			defaultPath: join(homedir(), "Downloads"),
			filters: [{name: "Meeting bundle", extensions: ["zip"]}],
			properties: ["openFile"],
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0]!;
	} catch (err) {
		console.error("[WhisperCal] Bundle picker failed:", err);
		new Notice("Couldn't open the file picker");
		return null;
	}
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

/**
 * Import a `.zip` produced by exportMeetingBundle: someone else's meeting, filed
 * into this vault as if it had been recorded here.
 *
 * The files cross over verbatim. A bundle is written by another WhisperCal vault,
 * so its frontmatter already has our shape and its links are already internally
 * consistent — and the sender's `calendar_event_id` needs no scrubbing to be
 * harmless, because an event id that isn't on our calendar is exactly what
 * findLocalNotes routes down its local-note path anyway. The meeting therefore
 * lands as an ad-hoc one: a card on its own date, resolved by subject+date, with
 * the whole pipeline available.
 *
 * Only two things are rewritten, and only because leaving them alone breaks
 * something concrete: `calendar_provider`, which the card is filtered on, and —
 * when a name is already taken — the links between the files we had to rename.
 */
export async function importMeetingBundle(app: App, settings: WhisperCalSettings): Promise<void> {
	if (!(app.vault.adapter instanceof FileSystemAdapter)) {
		new Notice("Import requires the desktop app");
		return;
	}

	const zipPath = await pickBundle();
	if (zipPath === null) return;

	let entries: Unzipped;
	try {
		const raw = await fs.readFile(zipPath);
		// Async unzip for the same reason export uses async zip: the .m4a dominates
		// the payload and doing it inline freezes Obsidian for the whole read.
		entries = await new Promise<Unzipped>((resolve, reject) => {
			unzip(new Uint8Array(raw), (err, data) => (err ? reject(err) : resolve(data)));
		});
	} catch (err) {
		console.error("[WhisperCal] Couldn't read bundle:", err);
		new Notice(err instanceof Error ? `Couldn't read bundle: ${err.message}` : "Couldn't read bundle");
		return;
	}

	// The archive is one flat folder, so only each entry's basename matters.
	// Bundles travel by email, so drop the directory entries and the macOS
	// archiver noise that rides along with them.
	const files = Object.entries(entries)
		.filter(([name]) => !name.endsWith("/")
			&& !name.split("/").some(p => p === "__MACOSX" || p === ".DS_Store" || p.startsWith("._")))
		.map(([name, data]) => ({name: name.split("/").pop() ?? name, data}));

	// No manifest to consult, so the members are told apart by the frontmatter
	// each writer stamps.
	let note: BundleDoc | null = null;
	let transcript: BundleDoc | null = null;
	let audio: {name: string; data: Uint8Array} | null = null;
	for (const f of files) {
		if (f.name.toLowerCase().endsWith(".md")) {
			const split = splitFrontmatter(new TextDecoder().decode(f.data));
			if (!split) continue;
			const doc: BundleDoc = {...split, basename: f.name.replace(/\.md$/i, "")};
			// Transcript first: it shares meeting_subject/meeting_date with the note,
			// so only its own markers separate the two.
			if (isTranscriptDoc(split.fm)) transcript ??= doc;
			else if (isNoteDoc(split.fm)) note ??= doc;
		} else {
			// The only non-markdown member an export ever writes is the transcript's audio.
			audio ??= f;
		}
	}

	if (!note) {
		new Notice("Not a meeting bundle — no meeting note inside");
		return;
	}
	// Audio is named after the transcript, so it has nowhere to hang without one.
	if (!transcript) audio = null;

	// Keep the sender's names. Only if one is already taken does everything shift
	// to a free suffix together — the transcript and audio by re-prefixing, the way
	// MeetingRenamer moves a meeting's files, so the shared-basename convention that
	// rename and delete depend on survives either way.
	const oldBase = note.basename;
	const reprefix = (name: string, base: string): string =>
		name.startsWith(oldBase) ? base + name.slice(oldBase.length) : name;
	const targetsFor = (base: string) => ({
		note: normalizePath(`${settings.noteFolderPath}/${base}.md`),
		transcript: transcript
			? normalizePath(`${settings.transcriptFolderPath}/${reprefix(transcript.basename, base)}.md`)
			: null,
		// Audio sits beside the transcript. There's no audio-folder setting — natively
		// the recorder picks the spot — and resolveTranscriptAudio finds it by the
		// `recording` link or the "<transcript basename>.m4a" convention regardless,
		// both of which resolve by basename and so are location-agnostic.
		audio: audio ? normalizePath(`${settings.transcriptFolderPath}/${reprefix(audio.name, base)}`) : null,
	});
	const allFree = (t: ReturnType<typeof targetsFor>): boolean =>
		Object.values(t).every(p => p === null || app.vault.getAbstractFileByPath(p) === null);

	let base = oldBase;
	let targets = targetsFor(base);
	for (let i = 2; !allFree(targets) && i < 100; i++) {
		base = `${oldBase} ${i}`;
		targets = targetsFor(base);
	}
	if (!allFree(targets)) {
		new Notice("Couldn't find a free name for this bundle — is it already imported?");
		return;
	}
	const renamed = base !== oldBase;

	const written: string[] = [];
	try {
		await ensureFolder(app, settings.noteFolderPath);
		if (transcript) await ensureFolder(app, settings.transcriptFolderPath);

		// findLocalNotes skips notes whose provider isn't ours, so a bundle from a
		// Google vault would otherwise import invisibly into a Graph one.
		const noteFm = editFrontmatter(note.rawFm, {
			calendar_provider: settings.calendarProvider,
			...(renamed && transcript
				? {[FM.TRANSCRIPT]: `"[[${yamlEscape(reprefix(transcript.basename, base))}]]"`}
				: {}),
		});
		await app.vault.create(targets.note, joinFrontmatter(noteFm, note.body));
		written.push(targets.note);

		if (audio && targets.audio) {
			await app.vault.createBinary(targets.audio, toArrayBuffer(audio.data));
			written.push(targets.audio);
		}

		if (transcript && targets.transcript) {
			const transcriptFm = renamed
				? editFrontmatter(transcript.rawFm, {
					[FM.MEETING_NOTE]: `"[[${yamlEscape(base)}]]"`,
					...(audio ? {recording: `"[[${yamlEscape(reprefix(audio.name, base))}]]"`} : {}),
				})
				: transcript.rawFm;
			// Written last, and only once the note is in place under its final name:
			// the pipeline_state mirror fires on any change under the transcript folder
			// and resolves meeting_note by basename, so a transcript landing first
			// could mirror the sender's state onto an unrelated note of ours.
			await app.vault.create(targets.transcript, joinFrontmatter(transcriptFm, transcript.body));
			written.push(targets.transcript);
		}
	} catch (err) {
		console.error("[WhisperCal] Import failed:", err);
		new Notice(err instanceof Error ? `Import failed: ${err.message}` : "Import failed");
		return;
	}

	new Notice(`Imported ${written.length} file${written.length === 1 ? "" : "s"} as "${base}"`);
	const file = app.vault.getAbstractFileByPath(targets.note);
	if (file instanceof TFile) await app.workspace.getLeaf("tab").openFile(file);
}
