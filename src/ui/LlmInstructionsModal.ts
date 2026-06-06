import {Modal, App} from "obsidian";
import {renderModalHeader} from "./ModalHeader";

/**
 * Small modal prompting for one-off custom instructions before an LLM run
 * (speaker tagging or summarization). Resolves with the trimmed instruction
 * text ("" means run without extra instructions), or null if cancelled.
 */
export class LlmInstructionsModal extends Modal {
	private resolve: ((value: string | null) => void) | null = null;
	private submitted = false;
	private title: string;
	private subtitle: string;
	private placeholder: string;
	private textareaEl!: HTMLTextAreaElement;

	constructor(app: App, opts: {title: string; subtitle?: string; placeholder?: string}) {
		super(app);
		this.title = opts.title;
		this.subtitle = opts.subtitle ?? "";
		this.placeholder = opts.placeholder ?? "Additional instructions for this run…";
	}

	prompt(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-instructions-modal");

		renderModalHeader(contentEl, this.title, this.subtitle);

		this.textareaEl = contentEl.createEl("textarea", {
			placeholder: this.placeholder,
			cls: "whisper-cal-instructions-textarea",
		});
		this.textareaEl.rows = 4;
		this.textareaEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submitted = true;
				this.close();
			}
		});

		const btnRow = contentEl.createDiv({cls: "whisper-cal-instructions-buttons"});
		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const runBtn = btnRow.createEl("button", {text: "Run", cls: "mod-cta"});
		runBtn.addEventListener("click", () => {
			this.submitted = true;
			this.close();
		});

		setTimeout(() => this.textareaEl.focus(), 10);
	}

	onClose(): void {
		const value = this.textareaEl.value.trim();
		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(this.submitted ? value : null);
				this.resolve = null;
			}
		}, 0);
	}
}
