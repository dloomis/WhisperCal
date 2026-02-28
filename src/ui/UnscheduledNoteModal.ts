import {App, Modal, Setting} from "obsidian";

export class UnscheduledNoteModal extends Modal {
	private subject = "";
	private resolve: ((value: string | null) => void) | null = null;

	constructor(app: App) {
		super(app);
	}

	prompt(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();

		contentEl.createEl("h3", {text: "Create unscheduled note"});

		const input = contentEl.createEl("input", {
			type: "text",
			placeholder: "Meeting subject",
			cls: "whisper-cal-modal-input",
		});
		input.addEventListener("input", () => {
			this.subject = input.value;
		});
		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && this.subject.trim()) {
				this.submit();
			}
		});
		setTimeout(() => input.focus(), 10);

		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText("Create")
					.setCta()
					.onClick(() => this.submit());
			})
			.addButton((btn) => {
				btn.setButtonText("Cancel")
					.onClick(() => this.cancel());
			});
	}

	private submit(): void {
		if (this.resolve && this.subject.trim()) {
			this.resolve(this.subject.trim());
			this.resolve = null;
			this.close();
		}
	}

	private cancel(): void {
		if (this.resolve) {
			this.resolve(null);
			this.resolve = null;
		}
		this.close();
	}

	onClose(): void {
		// If closed via Escape without explicit cancel/submit
		if (this.resolve) {
			this.resolve(null);
			this.resolve = null;
		}
		this.contentEl.empty();
	}
}
