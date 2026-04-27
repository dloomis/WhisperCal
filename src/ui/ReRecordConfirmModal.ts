import {Modal, type App} from "obsidian";

export type ReRecordChoice = "re-record" | "view" | null;

export interface ReRecordContext {
	/** Current pipeline_state from the meeting note frontmatter. */
	pipelineState?: string;
	/**
	 * Whether the transcript file is linked from the meeting note's frontmatter.
	 * When false, the transcript exists on disk but is orphaned — the modal
	 * adjusts copy to reflect that re-recording will overwrite the file rather
	 * than just clearing a link. Defaults to true.
	 */
	linked?: boolean;
}

/**
 * Confirmation modal shown when the user clicks Record on a meeting
 * that already has a transcript on disk (either linked from the note
 * or orphaned). Offers to re-record (destructive) or view the existing
 * transcript.
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
		const linked = this.context.linked !== false;

		contentEl.createEl("h3", {
			text: linked ? "Transcript already linked" : "Transcript file already exists",
		});

		if (speakersTagged) {
			const warn = contentEl.createDiv({cls: "whisper-cal-rerecord-alert"});
			warn.createEl("strong", {text: "Speaker tagging is complete."});
			warn.createEl("span", {
				text: " Re-recording will discard all speaker tags, the transcript, and any summary. Are you sure this isn't an accidental tap?",
			});
		} else if (linked) {
			contentEl.createEl("p", {
				text: "Re-recording will remove the existing transcript link, pipeline state, and any summary. This cannot be undone.",
				cls: "whisper-cal-rerecord-warning",
			});
		} else {
			contentEl.createEl("p", {
				text: "A transcript file for this meeting exists on disk but is not linked in the note's frontmatter. Re-recording will overwrite it. This cannot be undone.",
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
