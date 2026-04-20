import {Modal} from "obsidian";

export type RegenerateSummaryChoice = "open" | "regenerate" | null;

/**
 * Confirmation modal shown when the user clicks the Summary pill on a
 * meeting whose summary is already complete. Offers to open the note or
 * re-run the summarizer LLM.
 */
export class RegenerateSummaryModal extends Modal {
	private resolve: ((value: RegenerateSummaryChoice) => void) | null = null;
	private choice: RegenerateSummaryChoice = null;

	prompt(): Promise<RegenerateSummaryChoice> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-cached-proposal-modal");

		contentEl.createEl("h3", {text: "This meeting has already been summarized"});
		/* eslint-disable obsidianmd/ui/sentence-case */
		contentEl.createEl("p", {
			text: "You can open the meeting note to view the existing summary, or re-run the LLM to regenerate it (existing summary sections will be replaced).",
		});
		/* eslint-enable obsidianmd/ui/sentence-case */

		const btnRow = contentEl.createDiv({cls: "whisper-cal-cached-proposal-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const regenBtn = btnRow.createEl("button", {text: "Regenerate"});
		regenBtn.addEventListener("click", () => {
			this.choice = "regenerate";
			this.close();
		});

		const openBtn = btnRow.createEl("button", {
			text: "Open",
			cls: "mod-cta",
		});
		openBtn.addEventListener("click", () => {
			this.choice = "open";
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
