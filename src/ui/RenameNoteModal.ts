import {Modal, type App} from "obsidian";
import type {RelatedFile} from "../services/MeetingDeleter";
import {sanitizeFilename} from "../utils/sanitize";

export interface RenameNoteResult {
	/** New base name for the note (no path, no extension), already sanitized. */
	newName: string;
	/** Whether the user opted to also rename the meeting's related files. */
	renameRelated: boolean;
}

export interface RenameNoteContext {
	/** Current base name of the note (no path, no extension). */
	currentName: string;
	relatedFiles: readonly RelatedFile[];
}

/**
 * Rename a meeting note, mirroring DeleteNoteModal's look and feel. Resolves the
 * user's choice — the new name plus whether to also rename related files — or null
 * on cancel. The "also rename related files" option only appears when related
 * files actually exist and defaults ON, since the transcript/audio/sidecar are
 * named off the note and are normally kept in lock-step. The caller renames
 * everything via Obsidian's fileManager, so cross-vault links are preserved.
 */
export class RenameNoteModal extends Modal {
	private resolve: ((value: RenameNoteResult | null) => void) | null = null;
	private result: RenameNoteResult | null = null;
	private ctx: RenameNoteContext;

	constructor(app: App, ctx: RenameNoteContext) {
		super(app);
		this.ctx = ctx;
	}

	prompt(): Promise<RenameNoteResult | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-rename-note-modal");

		this.setTitle("Rename note");

		const input = contentEl.createEl("input", {
			cls: "whisper-cal-rename-input",
			type: "text",
			value: this.ctx.currentName,
		});
		input.setAttribute("aria-label", "New note name");

		let renameRelated = true;
		const related = this.ctx.relatedFiles;
		let list: HTMLUListElement | null = null;

		// Live preview of each related file's resulting name — recomputed as the
		// user types and toggled between old→new and old-only as the checkbox flips.
		const refreshList = (): void => {
			if (!list) return;
			list.empty();
			const raw = input.value.trim();
			const newBase = raw ? sanitizeFilename(raw) : "";
			for (const rf of related) {
				const li = list.createEl("li");
				if (renameRelated && newBase && rf.file.basename.startsWith(this.ctx.currentName)) {
					const suffix = rf.file.basename.slice(this.ctx.currentName.length);
					const ext = rf.file.extension ? `.${rf.file.extension}` : "";
					li.setText(`${rf.file.name} → ${newBase}${suffix}${ext}`);
				} else {
					li.setText(rf.file.name);
				}
			}
		};

		if (related.length > 0) {
			const wrap = contentEl.createDiv({cls: "whisper-cal-rename-related"});
			const label = wrap.createEl("label", {cls: "whisper-cal-rename-related-toggle"});
			const cb = label.createEl("input", {type: "checkbox"});
			cb.checked = true;
			label.createSpan({
				text: `Also rename ${related.length} related file${related.length === 1 ? "" : "s"}`,
			});
			cb.addEventListener("change", () => { renameRelated = cb.checked; refreshList(); });

			list = wrap.createEl("ul", {cls: "whisper-cal-rename-related-list"});
			refreshList();
		}

		const btnRow = contentEl.createDiv({cls: "whisper-cal-rename-buttons"});

		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const renameBtn = btnRow.createEl("button", {text: "Rename", cls: "mod-cta"});

		const submit = (): void => {
			const raw = input.value.trim();
			const newName = raw ? sanitizeFilename(raw) : "";
			// No-op if the name is empty or unchanged — just dismiss without renaming.
			if (!newName || newName === this.ctx.currentName) { this.close(); return; }
			this.result = {newName, renameRelated};
			this.close();
		};
		renameBtn.addEventListener("click", submit);

		const syncDisabled = (): void => {
			const raw = input.value.trim();
			const newName = raw ? sanitizeFilename(raw) : "";
			renameBtn.disabled = !newName || newName === this.ctx.currentName;
		};
		input.addEventListener("input", () => { refreshList(); syncDisabled(); });
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); submit(); }
		});
		syncDisabled();

		// Focus the field and select the whole name so the user can type over it.
		setTimeout(() => { input.focus(); input.select(); }, 0);
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
