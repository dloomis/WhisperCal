import {App, FuzzySuggestModal, TFolder} from "obsidian";

/**
 * Button-triggered folder picker: choose a vault folder from a searchable list — the
 * in-Obsidian equivalent of a native "Choose folder…" browser. Scoped to the vault,
 * where plugin-managed folders (like the voiceprint cache) must live. `pick()` resolves
 * to the chosen folder path, or null if dismissed.
 */
export class FolderSelectModal extends FuzzySuggestModal<string> {
	private resolvePick: ((value: string | null) => void) | null = null;
	private picked = false;

	constructor(app: App) {
		super(app);
		this.setPlaceholder("Choose a folder…");
	}

	getItems(): string[] {
		const folders: string[] = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f instanceof TFolder && f.path && f.path !== "/") folders.push(f.path);
		}
		return folders.sort((a, b) => a.localeCompare(b));
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		this.picked = true;
		this.resolvePick?.(item);
		this.resolvePick = null;
	}

	pick(): Promise<string | null> {
		return new Promise(resolve => {
			this.resolvePick = resolve;
			this.open();
		});
	}

	onClose(): void {
		super.onClose();
		// selectSuggestion() calls close() — and so onClose() — *before* onChooseItem,
		// so resolving the cancel inline here would beat the pick and always yield null.
		// Defer a tick so a pick in flight wins (matches EventSuggestModal).
		setTimeout(() => {
			if (!this.picked) {
				this.resolvePick?.(null);
				this.resolvePick = null;
			}
		}, 0);
	}
}
