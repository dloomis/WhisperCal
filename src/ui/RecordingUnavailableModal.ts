import {Modal, type App} from "obsidian";

/**
 * Shown when auto-record fires on a meeting-link click but the recording service
 * (Tome) isn't running — either no port file exists yet or the connection is
 * refused. Auto-record is a silent background action, so without this the user
 * would join the meeting believing it's being captured when nothing started.
 * The Retry button re-attempts the recording after the user launches Tome; the
 * caller re-resolves the base URL so a freshly started service is picked up.
 */
export class RecordingUnavailableModal extends Modal {
	private onRetry: () => void;

	constructor(app: App, onRetry: () => void) {
		super(app);
		this.onRetry = onRetry;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-rerecord-modal");

		this.setTitle("Recording didn't start");

		const p = contentEl.createEl("p", {cls: "whisper-cal-rerecord-warning"});
		p.appendText("The recording service could not be reached. ");
		p.createEl("strong", {text: "This meeting is not being recorded."});
		p.appendText(" Start Tome, then retry.");

		const btnRow = contentEl.createDiv({cls: "whisper-cal-rerecord-buttons"});
		btnRow.createEl("button", {text: "Dismiss"})
			.addEventListener("click", () => this.close());
		const retryBtn = btnRow.createEl("button", {text: "Retry", cls: "mod-cta"});
		retryBtn.addEventListener("click", () => {
			this.close();
			this.onRetry();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
