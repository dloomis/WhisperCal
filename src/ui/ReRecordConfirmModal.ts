import {Modal, type App} from "obsidian";

export type ReRecordChoice = "re-record" | "view" | null;

export interface ReRecordContext {
	/** Current pipeline_state from the meeting note frontmatter. */
	pipelineState?: string;
}

/**
 * Confirmation modal shown when the user clicks Record on a meeting
 * that already has a linked transcript. Offers to re-record (destructive)
 * or view the existing transcript.
 */
export class ReRecordConfirmModal extends Modal {
	private resolve: ((value: ReRecordChoice) => void) | null = null;
	private choice: ReRecordChoice = null;
	private context: ReRecordContext;

	constructor(app: App, context?: ReRecordContext) {
		super(app);
		this.context = context ?? {};
	}

	prompt(): Promise<ReRecordChoice> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-rerecord-modal");

		const speakersTagged = this.context.pipelineState
			&& this.context.pipelineState !== "titled";

		contentEl.createEl("h3", {text: "Transcript already linked"});

		if (speakersTagged) {
			const warn = contentEl.createDiv({cls: "whisper-cal-rerecord-alert"});
			warn.createEl("strong", {text: "Speaker tagging is complete."});
			warn.createEl("span", {
				text: " Re-recording will discard all speaker tags, the transcript, and any summary. Are you sure this isn't an accidental tap?",
			});
		} else {
			contentEl.createEl("p", {
				text: "Re-recording will remove the existing transcript link, pipeline state, and any summary. This cannot be undone.",
				cls: "whisper-cal-rerecord-warning",
			});
		}

		const btnRow = contentEl.createDiv({cls: "whisper-cal-rerecord-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const viewBtn = btnRow.createEl("button", {text: "View transcript"});
		viewBtn.addEventListener("click", () => {
			this.choice = "view";
			this.close();
		});

		const reRecordBtn = btnRow.createEl("button", {
			text: "Re-record",
			cls: "mod-warning",
		});
		reRecordBtn.addEventListener("click", () => {
			this.choice = "re-record";
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(this.choice);
				this.resolve = null;
			}
		}, 0);
	}
}
