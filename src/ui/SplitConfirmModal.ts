import {App, Modal} from "obsidian";
import {formatElapsed, formatTime} from "../utils/time";
import type {SplitPlan} from "../services/MeetingSplitter";

/**
 * Confirmation modal for splitting one recording into two meetings. Shows where
 * the cut lands (wall-clock time plus each half's speaker-line count and
 * duration) and prompts for the second meeting's name. Resolves with the trimmed
 * name, or null if cancelled.
 *
 * Mirrors MergeConfirmModal — same promise-based prompt(), same button row, same
 * "value read on close" pattern — so the two halves of the operation feel alike.
 */
export class SplitConfirmModal extends Modal {
	private resolve: ((value: string | null) => void) | null = null;
	private submitted = false;
	private plan: SplitPlan;
	private defaultName: string;
	private timezone: string;

	constructor(app: App, opts: {plan: SplitPlan; defaultName: string; timezone: string}) {
		super(app);
		this.plan = opts.plan;
		this.defaultName = opts.defaultName;
		this.timezone = opts.timezone;
	}

	prompt(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	private addHalf(list: HTMLElement, label: string, lines: number, seconds: number, from: Date): void {
		const row = list.createDiv({cls: "whisper-cal-split-confirm-row"});
		row.createSpan({cls: "whisper-cal-split-confirm-half", text: label});
		row.createSpan({
			cls: "whisper-cal-split-confirm-time",
			text: formatTime(from, this.timezone),
		});
		row.createSpan({
			cls: "whisper-cal-split-confirm-stats",
			text: `${lines} speaker line${lines === 1 ? "" : "s"}`
				+ (seconds > 0 ? ` · ${formatElapsed(seconds)}` : ""),
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		this.setTitle("Split transcript into two meetings");

		contentEl.createEl("p", {
			cls: "whisper-cal-split-confirm-hint",
			text: `The recording is cut at ${formatTime(this.plan.splitTime, this.timezone)}. `
				+ "Everything below the marker moves to a new transcript with its own meeting note; "
				+ "both halves keep sharing the one audio file.",
		});

		const list = contentEl.createDiv({cls: "whisper-cal-split-confirm-list"});
		this.addHalf(list, "Stays", this.plan.partALineCount, this.plan.partASeconds, this.plan.transcriptStart);
		this.addHalf(list, "Moves", this.plan.partBLineCount, this.plan.partBSeconds, this.plan.splitTime);

		if (this.plan.offsetIsEstimated) {
			contentEl.createEl("p", {
				cls: "whisper-cal-split-confirm-warning",
				text: "The transcript has no per-line timestamps, so the split time is estimated from position in the text.",
			});
		}

		const input = contentEl.createEl("input", {
			type: "text",
			cls: "whisper-cal-name-input",
			attr: {placeholder: "Second meeting name", "aria-label": "Second meeting name"},
		});
		input.value = this.defaultName;

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				if (!input.value.trim()) return; // a nameless meeting has nowhere to live
				this.submitted = true;
				this.close();
			}
		});

		const btnRow = contentEl.createDiv({cls: "whisper-cal-name-input-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const okBtn = btnRow.createEl("button", {text: "Split", cls: "mod-cta"});
		okBtn.addEventListener("click", () => {
			if (!input.value.trim()) {
				input.focus();
				return;
			}
			this.submitted = true;
			this.close();
		});

		setTimeout(() => {
			input.focus();
			input.select();
		}, 10);
	}

	onClose(): void {
		const input = this.contentEl.querySelector("input");
		const value = input?.value.trim() || null;
		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(this.submitted ? value : null);
				this.resolve = null;
			}
		}, 0);
	}
}
