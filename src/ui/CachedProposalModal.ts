import {Modal} from "obsidian";

export type CachedProposalChoice = "view" | "rerun" | null;

/**
 * Confirmation modal shown when the user clicks the Speakers pill
 * and cached LLM proposals exist in the transcript frontmatter.
 * Offers to view the cached proposals, re-run the LLM, or cancel.
 */
export class CachedProposalModal extends Modal {
	private resolve: ((value: CachedProposalChoice) => void) | null = null;
	private choice: CachedProposalChoice = null;

	prompt(): Promise<CachedProposalChoice> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-cached-proposal-modal");

		contentEl.createEl("h3", {text: "A prior speaker mapping is available"});
		/* eslint-disable obsidianmd/ui/sentence-case */
		contentEl.createEl("p", {
			text: "Speaker proposals from a previous run are cached on this transcript. You can review them or re-run the LLM for fresh results.",
		});
		/* eslint-enable obsidianmd/ui/sentence-case */

		const btnRow = contentEl.createDiv({cls: "whisper-cal-cached-proposal-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const rerunBtn = btnRow.createEl("button", {text: "Rerun"});
		rerunBtn.addEventListener("click", () => {
			this.choice = "rerun";
			this.close();
		});

		const viewBtn = btnRow.createEl("button", {
			text: "View",
			cls: "mod-cta",
		});
		viewBtn.addEventListener("click", () => {
			this.choice = "view";
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
