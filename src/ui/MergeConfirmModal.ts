import {App, Modal} from "obsidian";
import {readFmString} from "../utils/frontmatter";
import {formatTime} from "../utils/time";
import {FM} from "../constants";
import type {MergePart} from "../services/MeetingMerger";

/**
 * Confirmation modal for merging meeting cards. Lists the parts in
 * chronological order with their pipeline state and prompts for the merged
 * meeting name. Resolves with the trimmed name, or null if cancelled.
 */
export class MergeConfirmModal extends Modal {
	private resolve: ((value: string | null) => void) | null = null;
	private submitted = false;
	private parts: MergePart[];
	private defaultName: string;
	private timezone: string;

	constructor(app: App, opts: {parts: MergePart[]; defaultName: string; timezone: string}) {
		super(app);
		this.parts = opts.parts;
		this.defaultName = opts.defaultName;
		this.timezone = opts.timezone;
	}

	prompt(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	private partState(part: MergePart): string {
		if (!part.transcriptFile) return "no transcript";
		const state = readFmString(part.transcriptFm, FM.PIPELINE_STATE)
			?? readFmString(part.noteFm, FM.PIPELINE_STATE);
		switch (state) {
		case "tagged":
		case "summarized":
		case "research-done":
			return "tagged";
		case "titled":
		case "transcript":
			return "untagged";
		default:
			return state ?? "unknown";
		}
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.createEl("h3", {text: `Merge ${this.parts.length} meetings`});
		contentEl.createEl("p", {
			cls: "whisper-cal-merge-confirm-hint",
			text: "Parts are combined in time order into one note and transcript. Originals move to the archive folder.",
		});

		const list = contentEl.createDiv({cls: "whisper-cal-merge-confirm-list"});
		for (const part of this.parts) {
			const row = list.createDiv({cls: "whisper-cal-merge-confirm-row"});
			row.createSpan({
				cls: "whisper-cal-merge-confirm-time",
				text: formatTime(part.startTime, this.timezone),
			});
			row.createSpan({cls: "whisper-cal-merge-confirm-subject", text: part.subject});
			row.createSpan({cls: "whisper-cal-merge-confirm-state", text: this.partState(part)});
		}

		const input = contentEl.createEl("input", {
			type: "text",
			cls: "whisper-cal-name-input",
			attr: {placeholder: "Merged meeting name", "aria-label": "Merged meeting name"},
		});
		input.value = this.defaultName;

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submitted = true;
				this.close();
			}
		});

		const btnRow = contentEl.createDiv({cls: "whisper-cal-name-input-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const okBtn = btnRow.createEl("button", {text: "Merge", cls: "mod-cta"});
		okBtn.addEventListener("click", () => {
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
