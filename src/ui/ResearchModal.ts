import {Modal, App, TFile, setIcon} from "obsidian";
import {renderModalHeader} from "./ModalHeader";

export interface ResearchResult {
	paths: string[];
	instructions: string;
	bypassPrompt: boolean;
}

/**
 * Multi-select modal for choosing vault notes as meeting research context.
 * Returns selected note paths and optional additional instructions, or null if cancelled.
 */
export class ResearchModal extends Modal {
	private resolve: ((value: ResearchResult | null) => void) | null = null;
	private submitted = false;
	private meetingTitle: string;
	private meetingSubtitle: string;
	private selected: Set<string>;
	private chipsEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private instructionsEl!: HTMLTextAreaElement;
	private bypassCheckbox!: HTMLInputElement;
	private instructionsLabel!: HTMLElement;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, meetingTitle: string, subtitle: string, initialPaths?: string[]) {
		super(app);
		this.meetingTitle = meetingTitle;
		this.meetingSubtitle = subtitle;
		this.selected = new Set(initialPaths ?? []);
	}

	prompt(): Promise<ResearchResult | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-research-modal");

		renderModalHeader(contentEl, this.meetingTitle, this.meetingSubtitle);

		// Selected chips
		this.chipsEl = contentEl.createDiv({cls: "whisper-cal-research-chips"});
		this.renderChips();

		// Search input
		this.searchInput = contentEl.createEl("input", {
			type: "text",
			placeholder: "Search vault notes\u2026",
			cls: "whisper-cal-research-search",
		});
		this.searchInput.addEventListener("input", () => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => this.renderResults(), 150);
		});

		// Results list
		this.resultsEl = contentEl.createDiv({cls: "whisper-cal-research-results"});
		this.renderResults();

		// Bypass prompt checkbox
		const bypassRow = contentEl.createDiv({cls: "whisper-cal-research-bypass"});
		this.bypassCheckbox = bypassRow.createEl("input", {type: "checkbox"});
		this.bypassCheckbox.id = "whisper-cal-bypass-prompt";
		bypassRow.createEl("label", {
			text: "Use as direct prompt (bypass prompt file)",
			attr: {"for": "whisper-cal-bypass-prompt"},
		});
		this.bypassCheckbox.addEventListener("change", () => this.updateBypassState());

		// Instructions / direct prompt textarea
		this.instructionsLabel = contentEl.createEl("label", {
			text: "Additional instructions",
			cls: "whisper-cal-research-label",
		});
		this.instructionsEl = contentEl.createEl("textarea", {
			placeholder: "Additional instructions (optional)\u2026",
			cls: "whisper-cal-research-instructions",
		});
		this.instructionsEl.rows = 3;

		// Buttons
		const btnRow = contentEl.createDiv({cls: "whisper-cal-research-buttons"});
		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const submitBtn = btnRow.createEl("button", {text: "Research", cls: "mod-cta"});
		submitBtn.addEventListener("click", () => {
			this.submitted = true;
			this.close();
		});

		setTimeout(() => this.searchInput.focus(), 10);
	}

	private renderChips(): void {
		this.chipsEl.empty();
		for (const path of this.selected) {
			const chip = this.chipsEl.createDiv({cls: "whisper-cal-chip"});
			chip.createSpan({
				cls: "whisper-cal-chip-label",
				text: path.replace(/\.md$/, "").split("/").pop() ?? path,
			});
			const remove = chip.createSpan({cls: "whisper-cal-chip-remove"});
			setIcon(remove, "x");
			remove.addEventListener("click", () => {
				this.selected.delete(path);
				this.renderChips();
				this.renderResults();
			});
		}
	}

	private updateBypassState(): void {
		const bypass = this.bypassCheckbox.checked;
		this.instructionsLabel.textContent = bypass ? "Prompt" : "Additional instructions";
		this.instructionsEl.placeholder = bypass
			? "Enter your research prompt\u2026"
			: "Additional instructions (optional)\u2026";
		this.instructionsEl.rows = bypass ? 6 : 3;
	}

	private renderResults(): void {
		this.resultsEl.empty();
		const query = this.searchInput.value.toLowerCase();
		const allFiles = this.app.vault.getMarkdownFiles();

		// Filter and sort: selected items first, then by path match
		const matches: TFile[] = [];
		for (const file of allFiles) {
			if (!query || file.path.toLowerCase().includes(query) || file.basename.toLowerCase().includes(query)) {
				matches.push(file);
			}
		}
		matches.sort((a, b) => {
			const aSelected = this.selected.has(a.path) ? 0 : 1;
			const bSelected = this.selected.has(b.path) ? 0 : 1;
			if (aSelected !== bSelected) return aSelected - bSelected;
			return a.path.localeCompare(b.path);
		});

		const limited = matches.slice(0, 20);
		for (const file of limited) {
			const isSelected = this.selected.has(file.path);
			const item = this.resultsEl.createDiv({
				cls: `whisper-cal-research-item${isSelected ? " is-selected" : ""}`,
			});

			const check = item.createSpan({cls: "whisper-cal-research-check"});
			setIcon(check, isSelected ? "check-square" : "square");

			item.createSpan({
				text: file.path.replace(/\.md$/, ""),
				cls: "whisper-cal-research-item-path",
			});

			item.addEventListener("click", () => {
				if (this.selected.has(file.path)) {
					this.selected.delete(file.path);
				} else {
					this.selected.add(file.path);
				}
				this.renderChips();
				this.renderResults();
			});
		}

		if (limited.length === 0) {
			this.resultsEl.createDiv({
				text: query ? "No matching notes" : "No notes in vault",
				cls: "whisper-cal-research-empty",
			});
		}
	}

	onClose(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		const bypass = this.bypassCheckbox.checked;
		const text = this.instructionsEl.value.trim();
		const hasValidInput = bypass
			? text.length > 0                       // bypass mode: prompt text required
			: this.selected.size > 0;               // normal mode: notes required
		const result: ResearchResult | null = this.submitted && hasValidInput
			? {paths: [...this.selected], instructions: text, bypassPrompt: bypass}
			: null;

		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(result);
				this.resolve = null;
			}
		}, 0);
	}
}
