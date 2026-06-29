import {Modal, type App} from "obsidian";

/**
 * Shown when the user clicks Record but the recording service (Tome) reports it
 * is already actively recording. There's only one audio source on the machine, so
 * a concurrent capture can't work — Tome rejects /start — and it would only yield a
 * second transcript of the same audio. So we don't offer to "record anyway"; we
 * just tell the user to stop the in-progress recording first, naming its subject
 * when the service provides one.
 */
export class ActiveRecordingNoticeModal extends Modal {
	private subject?: string;

	constructor(app: App, subject?: string) {
		super(app);
		this.subject = subject;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-rerecord-modal");

		contentEl.createEl("h3", {text: "Recording already in progress"});

		const p = contentEl.createEl("p", {cls: "whisper-cal-rerecord-warning"});
		if (this.subject) {
			p.appendText("The recording service is already recording ");
			p.createEl("strong", {text: this.subject});
			p.appendText(". Stop that recording before starting a new one.");
		} else {
			p.setText(
				"The recording service is already recording. Stop that recording before starting a new one.",
			);
		}

		const btnRow = contentEl.createDiv({cls: "whisper-cal-rerecord-buttons"});
		const okBtn = btnRow.createEl("button", {text: "Got it", cls: "mod-cta"});
		okBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
