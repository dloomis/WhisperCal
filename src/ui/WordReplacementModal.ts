import {Modal, type App} from "obsidian";

/**
 * Confirmation modal shown before running word replacements on a note.
 * Offers a link to review the replacement list, plus Run / Cancel.
 */
export class WordReplacementModal extends Modal {
	private resolve: ((confirmed: boolean) => void) | null = null;
	private confirmed = false;
	private replacementFilePath: string;
	private targetName: string;

	constructor(app: App, replacementFilePath: string, targetName: string) {
		super(app);
		this.replacementFilePath = replacementFilePath;
		this.targetName = targetName;
	}

	prompt(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-word-replacement-modal");

		contentEl.createEl("h3", {text: "Run word replacements"});

		contentEl.createEl("p", {
			text: `This will apply all word replacement rules to "${this.targetName}". Replacements are case-sensitive and use word boundaries to avoid partial matches.`,
		});

		const reviewRow = contentEl.createDiv({cls: "whisper-cal-word-replacement-review"});
		const reviewLink = reviewRow.createEl("a", {text: "Review replacement list"});
		reviewLink.addEventListener("click", (e) => {
			e.preventDefault();
			void this.app.workspace.openLinkText(this.replacementFilePath, "", "tab");
		});

		const btnRow = contentEl.createDiv({cls: "whisper-cal-rerecord-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const runBtn = btnRow.createEl("button", {
			text: "Run",
			cls: "mod-cta",
		});
		runBtn.addEventListener("click", () => {
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
