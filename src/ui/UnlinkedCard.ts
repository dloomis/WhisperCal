import {App, Menu, TFile, setIcon} from "obsidian";
import type {UnlinkedRecording} from "../services/UnlinkedRecordingProvider";
import type {JobTracker} from "../services/JobTracker";
import type {CardUiState} from "../services/CardUiState";
import {FM} from "../constants";
import {formatTime, formatRecordingDuration} from "../utils/time";
import {readFmString, isSingleSourceTranscript} from "../utils/frontmatter";
import {addActivateOnKey} from "../utils/a11y";
import {hasCachedProposals, countCachedProposals} from "../services/SpeakerTagParser";
import {LlmInstructionsModal} from "./LlmInstructionsModal";
import {renderRailSeg, renderSmartBtn, renderActivityBadge, type RailSegState} from "./MeetingCard";

/**
 * Card for a transcript in the calendar view's "Unlinked transcripts" section.
 * The meeting card's layout cut down to what applies without a meeting note:
 * a time gutter (recording start and length) whose control slot holds the ⋯
 * menu, a title that opens the transcript, a three-segment rail (Link ·
 * Transcript · Speakers), and one smart button for the speaker-tagging step.
 *
 * Statuses, badges, and jobs are keyed by the transcript's own path — with no
 * meeting note, it stands in as the "note path" of the tagging pipeline.
 */
export interface UnlinkedCardOpts {
	app: App;
	recording: UnlinkedRecording;
	timezone: string;
	jobs: JobTracker;
	cardUi: CardUiState;
	llmEnabled: boolean;
	/** "Nov 5" (plus the year when it isn't the current one). */
	formatDate: (date: Date) => string;
	onLink: () => Promise<void>;
	/** Absent when there's no vault file to delete (MacWhisper-source entries). */
	onDelete?: () => void;
	onTagSpeakers?: (transcriptFile: TFile, transcriptFm: Record<string, unknown>, notePath: string, customInstructions?: string) => void;
	onReviewSpeakerCandidates?: (notePath: string) => void;
}

type SpeakerState = "none" | "incomplete" | "running" | "complete";

interface UnlinkedStates {
	transcriptFile: TFile | null;
	speakers: SpeakerState;
	candidatesReady: boolean;
}

/** Speaker-stage state of an unlinked transcript, shared with the section header's review count. */
export function computeUnlinkedStates(app: App, jobs: JobTracker, recording: UnlinkedRecording): UnlinkedStates {
	const path = recording.transcriptPath;
	const file = path ? app.vault.getAbstractFileByPath(path) : null;
	const transcriptFile = file instanceof TFile ? file : null;
	if (!transcriptFile) return {transcriptFile: null, speakers: "none", candidatesReady: false};
	const fm = (app.metadataCache.getFileCache(transcriptFile)?.frontmatter ?? {}) as Record<string, unknown>;
	const state = readFmString(fm, FM.PIPELINE_STATE);
	const speakers: SpeakerState = (state && state !== "titled") ? "complete"
		: jobs.has("speakerTag", transcriptFile.path) ? "running"
		: "incomplete";
	const candidatesReady = speakers === "incomplete" && hasCachedProposals(app, transcriptFile.path);
	return {transcriptFile, speakers, candidatesReady};
}

export function renderUnlinkedCard(container: HTMLElement, opts: UnlinkedCardOpts): HTMLElement {
	const {app, recording, timezone} = opts;
	const card = container.createDiv({cls: "whisper-cal-card whisper-cal-unlinked-card"});
	if (recording.transcriptPath) card.dataset.transcriptPath = recording.transcriptPath;

	// Gutter — recording start time and length, like a meeting card's. The control
	// slot (the ⋯ menu) is a child of the rail, positioned into the gutter.
	const gutter = card.createDiv({cls: "whisper-cal-card-gutter"});
	const timeDiv = gutter.createDiv({cls: "whisper-cal-card-gutter-time"});
	const timeStr = formatTime(recording.recordingStart, timezone);
	const match = timeStr.match(/^(.+)\s+(AM|PM)$/i);
	if (match) {
		timeDiv.createSpan({text: match[1]! + " "});
		timeDiv.createSpan({cls: "whisper-cal-card-gutter-period", text: match[2]!});
	} else {
		timeDiv.textContent = timeStr;
	}
	const durText = formatRecordingDuration(recording.durationSeconds);
	if (durText) gutter.createDiv({cls: "whisper-cal-card-gutter-duration", text: durText});

	const content = card.createDiv({cls: "whisper-cal-card-content"});
	const subjectRow = content.createDiv({cls: "whisper-cal-card-subject-row"});
	const title = recording.title || "Untitled recording";
	if (recording.transcriptPath) {
		const transcriptPath = recording.transcriptPath;
		const subjectEl = subjectRow.createDiv({
			cls: "whisper-cal-card-subject whisper-cal-card-subject-link",
			text: title,
			attr: {"aria-label": "Open transcript"},
		});
		subjectEl.addEventListener("click", () => { void app.workspace.openLinkText(transcriptPath, "", false); });
		addActivateOnKey(subjectEl);
	} else {
		subjectRow.createDiv({cls: "whisper-cal-card-subject", text: title});
	}

	// Meta row — always present (the date is), so the rail sits as low as a
	// meeting card's and the gutter's control slot clears the time and length.
	const meta = content.createDiv({cls: "whisper-cal-card-meta"});
	const metaItem = (icon: string, text: string) => {
		const item = meta.createSpan({cls: "whisper-cal-card-meta-item"});
		setIcon(item.createSpan({cls: "whisper-cal-card-icon"}), icon);
		item.createSpan({text});
	};
	metaItem("calendar", opts.formatDate(recording.recordingStart));
	if (recording.speakerCount > 0) {
		metaItem("users-round", `${recording.speakerCount} speaker${recording.speakerCount === 1 ? "" : "s"}`);
	}

	const dynamicZone = content.createDiv({cls: "whisper-cal-card-dynamic"});
	renderUnlinkedDynamic(dynamicZone, card, opts);
	return card;
}

/** Rebuild only the dynamic zone (rail, controls, badge, smart button) in place. */
export function updateUnlinkedCard(cardEl: HTMLElement, opts: UnlinkedCardOpts): void {
	const zone = cardEl.querySelector(".whisper-cal-card-dynamic");
	if (zone instanceof HTMLElement) renderUnlinkedDynamic(zone, cardEl, opts);
}

function renderUnlinkedDynamic(zone: HTMLElement, cardEl: HTMLElement, opts: UnlinkedCardOpts): void {
	zone.empty();
	const {app, recording, cardUi} = opts;
	const states = computeUnlinkedStates(app, opts.jobs, recording);
	const tf = states.transcriptFile;
	// Status key: the transcript stands in for the meeting note (see the class doc).
	const statusKey = tf?.path ?? recording.transcriptPath ?? "";
	const llmOn = opts.llmEnabled;
	const tagging = states.speakers === "running";

	const openTranscript = tf ? () => { void app.workspace.openLinkText(tf.path, "", false); } : undefined;
	const runTagSpeakers = (file: TFile) => {
		const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
		const singleSource = isSingleSourceTranscript(fm);
		void (async () => {
			const instructions = await new LlmInstructionsModal(app, {
				title: "Tag speakers with instructions",
				subtitle: singleSource
					? "Single-mic recording — if more than one person spoke, say how many and who's who."
					: (recording.title || file.basename),
				...(singleSource
					? {placeholder: "e.g. \"Phone call held up to the mic: I am the local speaker, the other voice is Joe Jackson.\""}
					: {}),
			}).prompt();
			if (instructions === null) return;
			opts.onTagSpeakers?.(file, fm, file.path, instructions || undefined);
		})();
	};
	const review = () => { if (tf) opts.onReviewSpeakerCandidates?.(tf.path); };
	// One link flow at a time per card — the flag lives on the card element so it
	// survives the re-renders that happen while the picker is open.
	const link = () => {
		if (cardEl.dataset.linking === "1") return;
		cardEl.dataset.linking = "1";
		void opts.onLink().finally(() => { delete cardEl.dataset.linking; });
	};

	const buildMenu = (): Menu => {
		const menu = new Menu();
		if (tf) {
			menu.addItem((item) => item
				.setTitle("Open transcript")
				.setIcon("file-text")
				.onClick(() => openTranscript?.()));
		}
		if (llmOn && tf && opts.onReviewSpeakerCandidates && states.candidatesReady) {
			menu.addItem((item) => item
				.setTitle("Review speaker candidates")
				.setIcon("user-round-check")
				.onClick(review));
		} else if (llmOn && tf && opts.onTagSpeakers && states.speakers === "incomplete") {
			menu.addItem((item) => item
				.setTitle("Tag speakers…")
				.setIcon("user-round-plus")
				.onClick(() => runTagSpeakers(tf)));
		} else if (llmOn && tf && opts.onReviewSpeakerCandidates && states.speakers === "complete") {
			menu.addItem((item) => item
				.setTitle("Edit speaker tags")
				.setIcon("user-round-cog")
				.onClick(review));
		}
		// Linking renames the transcript, which would strand a tagging run's
		// writes under the old path — held back until the run finishes.
		menu.addItem((item) => item
			.setTitle("Link to meeting…")
			.setIcon("link")
			.setDisabled(tagging)
			.onClick(link));
		if (opts.onDelete && !tagging) {
			const onDelete = opts.onDelete;
			menu.addSeparator();
			menu.addItem((item) => item
				.setTitle("Delete transcript…")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(onDelete));
		}
		return menu;
	};

	const expandGroup = zone.createDiv({cls: "whisper-cal-card-expand"});
	const rail = expandGroup.createDiv({cls: "whisper-cal-rail"});

	// Gutter control slot — just the ⋯ menu (Link lives on the rail).
	const slot = rail.createDiv({cls: "whisper-cal-card-gutter-record"});
	const moreMini = slot.createEl("button", {cls: "whisper-cal-mini", attr: {"aria-label": "More actions"}});
	setIcon(moreMini.createSpan({cls: "whisper-cal-mini-icon"}), "ellipsis");
	moreMini.addEventListener("click", () => {
		const rect = moreMini.getBoundingClientRect();
		buildMenu().showAtPosition({x: rect.left, y: rect.bottom + 4});
	});

	// Link — the first segment, standing where a meeting card's Note is (linking is
	// what gives the transcript its note). Flagged once it's the only step left:
	// speakers tagged, or nothing to tag (MacWhisper entry, LLM features off).
	// Disabled while tagging runs, with a tooltip saying why.
	const linkIsNext = states.speakers === "complete" || !tf || !llmOn;
	renderRailSeg(rail, "Link", linkIsNext ? "attention" : "pending",
		tagging ? undefined : link, "Link after speaker tagging finishes");
	renderRailSeg(rail, "Transcript", tf ? "done" : "pending", openTranscript, "Link to create the transcript");

	let speakersSeg: RailSegState;
	if (states.candidatesReady) speakersSeg = "attention";
	else if (states.speakers === "running") speakersSeg = "running";
	else if (states.speakers === "complete") speakersSeg = "done";
	else if (states.speakers === "incomplete" && llmOn) speakersSeg = "attention";
	else speakersSeg = "pending";
	const openSpeakers = llmOn && opts.onReviewSpeakerCandidates && tf
		&& (states.candidatesReady || states.speakers === "complete")
		? review
		: openTranscript;
	renderRailSeg(rail, "Speakers", speakersSeg, openSpeakers, "Link first to tag speakers");

	const badgeStatus = statusKey ? cardUi.getStatus(statusKey) : undefined;
	cardEl.toggleClass("whisper-cal-card-has-badge", !!badgeStatus?.badge);

	const actionsWrap = expandGroup.createDiv({cls: "whisper-cal-card-actions-wrap"});
	const actions = actionsWrap.createDiv({cls: "whisper-cal-card-actions"});
	if (badgeStatus) renderActivityBadge(actions, badgeStatus);

	// Smart button — the speaker step only; no button while a job runs or once tagged.
	if (llmOn && tf && !tagging) {
		if (states.candidatesReady && opts.onReviewSpeakerCandidates) {
			const count = countCachedProposals(app, tf.path);
			const btn = renderSmartBtn(actions, "user-round-check", "Review speakers", {cls: "whisper-cal-smart-review", count, ariaLabel: "Review speakers"});
			btn.addEventListener("click", review);
		} else if (states.speakers === "incomplete" && opts.onTagSpeakers) {
			const btn = renderSmartBtn(actions, "user-round-plus", "Tag speakers…", {ariaLabel: "Tag speakers"});
			btn.addEventListener("click", () => runTagSpeakers(tf));
		}
	}

	cardEl.oncontextmenu = (e) => {
		if (e.target instanceof Element && e.target.closest("a")) return;
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) return;
		e.preventDefault();
		buildMenu().showAtMouseEvent(e);
	};
}
