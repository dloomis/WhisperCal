import {Modal, App} from "obsidian";

/**
 * Simple modal that prompts the user for a meeting name.
 * Resolves with the trimmed string, or null if cancelled.
 */
export class NameInputModal extends Modal {
	private resolve: ((value: string | null) => void) | null = null;
	private submitted = false;
	private defaultValue: string;
	private placeholder: string;

	constructor(app: App, opts?: {defaultValue?: string; placeholder?: string}) {
		super(app);
		this.defaultValue = opts?.defaultValue ?? "";
		this.placeholder = opts?.placeholder ?? "Meeting name";
	}

	prompt(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.createEl("h3", {text: "Name this meeting"});

		const input = contentEl.createEl("input", {
			type: "text",
			cls: "whisper-cal-name-input",
			attr: {placeholder: this.placeholder},
		});
		input.value = this.defaultValue;

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

		const okBtn = btnRow.createEl("button", {text: "Create", cls: "mod-cta"});
		okBtn.addEventListener("click", () => {
			this.submitted = true;
			this.close();
		});

		// Focus and select the input text
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
