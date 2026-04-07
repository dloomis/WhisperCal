import {Modal, type App} from "obsidian";

/**
 * Confirmation modal shown before deleting an unlinked transcript.
 * Resolves `true` if the user confirms, `false` / `null` if cancelled.
 */
export class DeleteTranscriptModal extends Modal {
	private resolve: ((value: boolean) => void) | null = null;
	private confirmed = false;
	private title: string;

	constructor(app: App, title: string) {
		super(app);
		this.title = title;
	}

	prompt(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-delete-transcript-modal");

		contentEl.createEl("h3", {text: "Delete transcript"});

		contentEl.createEl("p", {
			text: `Are you sure you want to delete "${this.title}"? The transcript file will be moved to the system trash.`,
			cls: "whisper-cal-delete-warning",
		});

		const btnRow = contentEl.createDiv({cls: "whisper-cal-delete-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const deleteBtn = btnRow.createEl("button", {
			text: "Delete",
			cls: "mod-warning",
		});
		deleteBtn.addEventListener("click", () => {
			this.confirmed = true;
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(this.confirmed);
				this.resolve = null;
			}
		}, 0);
	}
}
