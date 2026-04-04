import {Modal, type App} from "obsidian";

export interface WordReplacementResult {
	confirmed: boolean;
	doNotShowAgain: boolean;
}

/**
 * Confirmation modal shown before running word replacements on a note.
 * Offers a link to review the replacement list, plus Run / Cancel.
 * Includes a "Do not show again" checkbox so the user can bypass future prompts.
 */
export class WordReplacementModal extends Modal {
	private resolve: ((result: WordReplacementResult) => void) | null = null;
	private confirmed = false;
	private doNotShowAgain = false;
	private replacementFilePath: string;
	private targetName: string;

	constructor(app: App, replacementFilePath: string, targetName: string) {
		super(app);
		this.replacementFilePath = replacementFilePath;
		this.targetName = targetName;
	}

	prompt(): Promise<WordReplacementResult> {
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

		const checkboxRow = contentEl.createDiv({cls: "whisper-cal-word-replacement-checkbox"});
		const label = checkboxRow.createEl("label");
		const checkbox = label.createEl("input", {type: "checkbox"});
		label.appendText(" Do not show again");
		checkbox.addEventListener("change", () => {
			this.doNotShowAgain = checkbox.checked;
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
				this.resolve({
					confirmed: this.confirmed,
					doNotShowAgain: this.doNotShowAgain && this.confirmed,
				});
				this.resolve = null;
			}
		}, 0);
	}
}
