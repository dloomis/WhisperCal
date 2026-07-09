import {App, FileSystemAdapter, Notice, TFile} from "obsidian";
import {execFile} from "child_process";
import {promises as fs} from "fs";
import {join} from "path";
import {homedir, tmpdir} from "os";
import {promisify} from "util";
import {FM} from "../constants";
import {resolveWikiLink, resolveTranscriptAudio} from "../utils/vault";

const execFileAsync = promisify(execFile);

interface RemoteDialogModule {
	dialog?: {
		showOpenDialog(opts: {
			title?: string;
			buttonLabel?: string;
			defaultPath?: string;
			properties: string[];
		}): Promise<{canceled: boolean; filePaths: string[]}>;
	};
}

/**
 * Require a module through the window global so esbuild doesn't try to bundle
 * it. Needed only for `@electron/remote` (exposed by Obsidian's desktop
 * runtime but not in esbuild's external list); plain `electron` is external
 * and can be required directly.
 */
function windowRequire(module: string): unknown {
	const req = (window as unknown as {require?: (m: string) => unknown}).require;
	try {
		return req ? req(module) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Ask for a destination folder via the system picker. Returns null when the
 * user cancels. If the remote dialog API isn't reachable or errors, fall back
 * to ~/Downloads — announced via Notice so the write is never silent.
 */
async function pickDestination(): Promise<string | null> {
	const remote = windowRequire("@electron/remote") as RemoteDialogModule | undefined;
	if (remote?.dialog) {
		try {
			const result = await remote.dialog.showOpenDialog({
				title: "Choose export destination",
				buttonLabel: "Export",
				defaultPath: join(homedir(), "Downloads"),
				properties: ["openDirectory", "createDirectory"],
			});
			if (result.canceled || result.filePaths.length === 0) return null;
			return result.filePaths[0]!;
		} catch (err) {
			console.error("[WhisperCal] Folder picker failed, falling back to Downloads:", err);
		}
	}
	const fallback = join(homedir(), "Downloads");
	new Notice(`System folder picker unavailable — exporting to ${fallback}`);
	return fallback;
}

/**
 * Export a meeting's artifacts as a single `.zip` bundle outside the vault —
 * easy to attach to an email. The archive holds one flat folder (named for the
 * meeting) containing the meeting note (which carries the summary and any
 * research section), the linked transcript, and the transcript's source audio
 * when present. Files are copied verbatim; because the bundle is flat, wiki
 * links between them still resolve by basename if the folder is opened as a
 * vault after extraction.
 */
export async function exportMeetingBundle(app: App, notePath: string): Promise<void> {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		new Notice("Export requires the desktop app");
		return;
	}
	const noteFile = app.vault.getAbstractFileByPath(notePath);
	if (!(noteFile instanceof TFile)) {
		new Notice("Meeting note not found");
		return;
	}

	const noteFm: Record<string, unknown> = app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {};
	const files: TFile[] = [noteFile];
	const transcriptFile = resolveWikiLink(app, noteFm, FM.TRANSCRIPT, notePath);
	if (transcriptFile) {
		files.push(transcriptFile);
		const transcriptFm: Record<string, unknown> =
			app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {};
		const audioFile = resolveTranscriptAudio(app, transcriptFile, transcriptFm);
		if (audioFile) files.push(audioFile);
	} else if (noteFm[FM.TRANSCRIPT]) {
		// The note claims a transcript but the link doesn't resolve (renamed or
		// moved file) — export what we have, but don't let it look complete.
		new Notice("Transcript link couldn't be resolved — exporting the note only");
	}

	const destRoot = await pickDestination();
	if (destRoot === null) return;

	const zipPath = join(destRoot, `${noteFile.basename}.zip`);
	const basePath = adapter.getBasePath();
	// Stage the files under a folder named for the meeting inside a scratch dir,
	// then zip that folder so the archive extracts to one tidy, named directory.
	let stageRoot: string | null = null;
	try {
		stageRoot = await fs.mkdtemp(join(tmpdir(), "whispercal-export-"));
		const bundleDir = join(stageRoot, noteFile.basename);
		await fs.mkdir(bundleDir, {recursive: true});
		for (const f of files) {
			await fs.copyFile(join(basePath, f.path), join(bundleDir, f.name));
		}
		// zip appends to an existing archive, so clear a stale one first to avoid
		// leaving behind entries from a previous export of the same meeting.
		await fs.rm(zipPath, {force: true});
		// -r recurse, -q quiet, -X drop extra macOS attributes; run from the stage
		// root so archive paths are relative to the bundle folder, not absolute.
		await execFileAsync("/usr/bin/zip", ["-r", "-q", "-X", zipPath, noteFile.basename], {
			cwd: stageRoot,
		});
	} catch (err) {
		console.error("[WhisperCal] Export failed:", err);
		new Notice(err instanceof Error ? `Export failed: ${err.message}` : "Export failed");
		return;
	} finally {
		if (stageRoot) await fs.rm(stageRoot, {recursive: true, force: true}).catch(() => {});
	}

	new Notice(`Exported ${files.length} file${files.length === 1 ? "" : "s"} to ${zipPath}`);
	// Best-effort file-manager reveal — the export already succeeded
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
		const electron = require("electron") as {shell: {showItemInFolder(path: string): void}};
		electron.shell.showItemInFolder(zipPath);
	} catch (err) {
		console.warn("[WhisperCal] Could not reveal export folder:", err);
	}
}
