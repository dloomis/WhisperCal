import {Modal, type App} from "obsidian";
import type {RelatedFile} from "../services/MeetingDeleter";

export interface DeleteTranscriptResult {
	/** Whether the user opted to also delete the transcript's related files. */
	deleteRelated: boolean;
}

export interface DeleteTranscriptContext {
	title: string;
	relatedFiles: readonly RelatedFile[];
}

/**
 * Confirmation modal shown before deleting an unlinked transcript. Resolves the
 * user's choice — including whether to also delete the transcript's companions
 * (audio, voiceprint sidecar) — or null on cancel. Mirrors DeleteNoteModal: the
 * "also delete related files" option defaults OFF and only appears when related
 * files actually exist.
 */
export class DeleteTranscriptModal extends Modal {
	private resolve: ((value: DeleteTranscriptResult | null) => void) | null = null;
	private result: DeleteTranscriptResult | null = null;
	private ctx: DeleteTranscriptContext;

	constructor(app: App, ctx: DeleteTranscriptContext) {
		super(app);
		this.ctx = ctx;
	}

	prompt(): Promise<DeleteTranscriptResult | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-delete-transcript-modal");

		this.setTitle("Delete transcript");

		contentEl.createEl("p", {
			text: `Are you sure you want to delete "${this.ctx.title}"? The transcript file will be moved to the system trash.`,
			cls: "whisper-cal-delete-warning",
		});

		let deleteRelated = false;
		const related = this.ctx.relatedFiles;
		if (related.length > 0) {
			const wrap = contentEl.createDiv({cls: "whisper-cal-delete-related"});
			const label = wrap.createEl("label", {cls: "whisper-cal-delete-related-toggle"});
			const cb = label.createEl("input", {type: "checkbox"});
			cb.checked = false;
			label.createSpan({
				text: `Also delete ${related.length} related file${related.length === 1 ? "" : "s"}`,
			});
			cb.addEventListener("change", () => { deleteRelated = cb.checked; });

			const list = wrap.createEl("ul", {cls: "whisper-cal-delete-related-list"});
			for (const rf of related) {
				list.createEl("li", {text: rf.file.name});
			}
		}

		const btnRow = contentEl.createDiv({cls: "whisper-cal-delete-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const deleteBtn = btnRow.createEl("button", {
			text: "Delete",
			cls: "mod-warning",
		});
		deleteBtn.addEventListener("click", () => {
			this.result = {deleteRelated};
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(this.result);
				this.resolve = null;
			}
		}, 0);
	}
}
