import {Modal, type App} from "obsidian";
import type {RelatedFile} from "../services/MeetingDeleter";

export interface DeleteNoteResult {
	/** Whether the user opted to also delete the meeting's related files. */
	deleteRelated: boolean;
}

export interface DeleteNoteContext {
	subject: string;
	relatedFiles: readonly RelatedFile[];
}

/**
 * Destructive-action confirmation for deleting a meeting note. Resolves the user's
 * choice — including whether to also delete related files — or null on cancel. The
 * "also delete related files" option defaults OFF and only appears when related
 * files actually exist. The caller trashes everything via Obsidian's fileManager,
 * so the note (and any related files) stay recoverable per the user's "Deleted
 * files" setting — no bespoke recovery here.
 */
export class DeleteNoteModal extends Modal {
	private resolve: ((value: DeleteNoteResult | null) => void) | null = null;
	private result: DeleteNoteResult | null = null;
	private ctx: DeleteNoteContext;

	constructor(app: App, ctx: DeleteNoteContext) {
		super(app);
		this.ctx = ctx;
	}

	prompt(): Promise<DeleteNoteResult | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-delete-note-modal");

		contentEl.createEl("h3", {text: "Delete note"});

		contentEl.createEl("p", {
			cls: "whisper-cal-delete-warning",
			text: `Delete "${this.ctx.subject}"? It will be moved to trash — you can recover it from there.`,
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

		const deleteBtn = btnRow.createEl("button", {text: "Delete", cls: "mod-warning"});
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
