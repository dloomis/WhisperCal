import {App, Notice, TFile, TFolder, normalizePath} from "obsidian";
import {tomeHealth, tomeStart, tomeStop, tomeStatus} from "./TomeApi";
import {updateFrontmatter} from "../utils/frontmatter";
import {tomeRecordingState} from "../state";
import {sleep} from "../utils/time";
import type {CalendarEvent} from "../types";
import {resolveWikiLink} from "../utils/vault";

function getTranscriptFilename(notePath: string): string {
	const basename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "Transcript";
	return `${basename} - Transcript`;
}

function getTranscriptPath(notePath: string, transcriptFolderPath: string): string {
	return normalizePath(`${transcriptFolderPath}/${getTranscriptFilename(notePath)}.md`);
}

export async function startTomeRecording(opts: {
	app: App;
	notePath: string;
	event: CalendarEvent;
	transcriptFolderPath: string;
}): Promise<void> {
	const {notePath, event} = opts;

	const health = await tomeHealth();
	if (!health.modelsReady) {
		throw new Error("Tome is still loading models\u2026");
	}
	if (health.isRecording) {
		throw new Error("Tome is already recording");
	}

	const suggestedFilename = getTranscriptFilename(notePath);

	await tomeStart(suggestedFilename, {
		subject: event.subject,
		attendees: event.attendees.map(a => a.name || a.email),
	});

	tomeRecordingState.set(notePath, suggestedFilename);
	console.debug(`[WhisperCal] Tome recording started for ${notePath}`);
}

export async function stopTomeRecording(opts: {
	app: App;
	notePath: string;
	transcriptFolderPath: string;
}): Promise<void> {
	const {app, notePath, transcriptFolderPath} = opts;

	await tomeStop();
	tomeRecordingState.delete(notePath);
	console.debug(`[WhisperCal] Tome recording stopped for ${notePath}`);

	// Fire-and-forget: wait for transcription then link
	void waitAndLink(app, notePath, transcriptFolderPath);
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 100; // ~5 minutes

/** Find the newest file in a folder created after a given timestamp. */
function findNewestFile(app: App, folderPath: string, afterMs: number): TFile | null {
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return null;
	let newest: TFile | null = null;
	let newestTime = afterMs;
	for (const child of folder.children) {
		if (child instanceof TFile && child.stat.ctime > newestTime) {
			newest = child;
			newestTime = child.stat.ctime;
		}
	}
	return newest;
}

async function waitAndLink(app: App, notePath: string, transcriptFolderPath: string): Promise<void> {
	const beforeStop = Date.now();
	const notice = new Notice("Recording stopped \u2014 waiting for transcript\u2026", 0);
	try {
		// Poll Tome status until transcription completes
		for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
			await sleep(POLL_INTERVAL_MS);
			try {
				const {state} = await tomeStatus();
				if (state === "complete") break;
				if (state === "transcribing") {
					notice.setMessage("Transcribing\u2026");
				}
			} catch {
				// Tome may have shut down — fall through to file check
				break;
			}
			if (i === MAX_POLL_ATTEMPTS - 1) {
				notice.setMessage("Transcript not ready yet \u2014 check Tome");
				setTimeout(() => notice.hide(), 6000);
				return;
			}
		}

		// Look for the transcript file in the vault
		const expectedPath = getTranscriptPath(notePath, transcriptFolderPath);
		let transcriptFile: TFile | null = null;

		// Wait for the file to appear — check expected path first, then scan folder
		for (let i = 0; i < 15 && !transcriptFile; i++) {
			await sleep(1000);
			const byPath = app.vault.getAbstractFileByPath(expectedPath);
			if (byPath instanceof TFile) {
				transcriptFile = byPath;
			} else {
				// Fallback: find the newest file in the transcript folder
				transcriptFile = findNewestFile(app, transcriptFolderPath, beforeStop);
			}
		}

		if (!transcriptFile) {
			notice.setMessage("Transcript file not found \u2014 check Tome output folder");
			setTimeout(() => notice.hide(), 6000);
			return;
		}

		// Link transcript to meeting note
		const transcriptBasename = transcriptFile.basename;
		await updateFrontmatter(app, notePath, "transcript", `[[${transcriptBasename}]]`);
		notice.setMessage("Transcript linked to note");
		setTimeout(() => notice.hide(), 4000);
	} catch (err) {
		console.error("[WhisperCal] Tome transcript linking failed:", err);
		notice.setMessage("Failed to link transcript");
		setTimeout(() => notice.hide(), 6000);
	}
}

/** Check if a meeting note already has a Tome or MacWhisper transcript linked. */
export function hasLinkedTranscript(app: App, notePath: string): boolean {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return false;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return !!fm?.["transcript"];
}

/** Resolve and return the linked transcript TFile, if any. */
export function getLinkedTranscriptFile(app: App, notePath: string): TFile | null {
	const file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return null;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	return resolveWikiLink(app, fm, "transcript", notePath);
}
