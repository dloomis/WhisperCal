import {Modal, type App} from "obsidian";

/**
 * Shown when the user clicks Record but the recording service (Tome) reports it
 * is already actively recording. Rather than pre-locking sibling cards from
 * WhisperCal's own (drift-prone) state, we ask the service at click time and let
 * the user decide: proceed with a new recording anyway — the service owns whether
 * to run them concurrently — or cancel. Surfaces the subject of the in-progress
 * recording when the service provides one.
 */
export class ActiveRecordingConfirmModal extends Modal {
	private resolve: ((proceed: boolean) => void) | null = null;
	private proceed = false;
	private subject?: string;

	constructor(app: App, subject?: string) {
		super(app);
		this.subject = subject;
	}

	prompt(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-rerecord-modal");

		contentEl.createEl("h3", {text: "Recording already in progress"});

		const p = contentEl.createEl("p", {cls: "whisper-cal-rerecord-warning"});
		if (this.subject) {
			p.appendText("The recording service is already recording ");
			p.createEl("strong", {text: this.subject});
			p.appendText(". Start a new recording anyway?");
		} else {
			p.setText("The recording service is already recording. Start a new recording anyway?");
		}

		const btnRow = contentEl.createDiv({cls: "whisper-cal-rerecord-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const proceedBtn = btnRow.createEl("button", {text: "Record anyway", cls: "mod-warning"});
		proceedBtn.addEventListener("click", () => {
			this.proceed = true;
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(this.proceed);
				this.resolve = null;
			}
		}, 0);
	}
}
