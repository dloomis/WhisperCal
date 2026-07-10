import {Modal, App, Menu, TFile, setIcon} from "obsidian";
import {renderModalHeader} from "./ModalHeader";
import {addActivateOnKey} from "../utils/a11y";

type SortMode =
	| "name-asc" | "name-desc"
	| "mtime-desc" | "mtime-asc"
	| "ctime-desc" | "ctime-asc";

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
	private advancedEl!: HTMLElement;
	private toggleChevron!: HTMLElement;
	private toggleText!: HTMLElement;
	private submitBtn!: HTMLButtonElement;
	private errorEl!: HTMLElement;
	private initialInstructions: string;
	private initialBypass: boolean;
	private researchPromptPath: string | null;
	private folderFilter = "";
	// Default matches the "newest first" ordering; the sort menu can override it.
	private sortMode: SortMode = "mtime-desc";
	private seriesNotePath: string | null;
	// A series note that exists but has no prep yet: the modal opens blank, so we
	// show a tip pointing the user to it. Mutually exclusive with seriesNotePath.
	private emptySeriesNotePath: string | null;
	// Series prep gives the modal a runnable default (a prompt and/or context
	// notes), so the note picker and prompt editor collapse behind a disclosure.
	// Ad-hoc research has no default, so it shows those controls outright.
	private collapsible = false;
	private expanded = false;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, meetingTitle: string, subtitle: string,
		initialPaths?: string[], initialInstructions?: string, initialBypass?: boolean,
		seriesNotePath?: string, emptySeriesNotePath?: string, researchPromptPath?: string) {
		super(app);
		this.meetingTitle = meetingTitle;
		this.meetingSubtitle = subtitle;
		this.selected = new Set(initialPaths ?? []);
		this.initialInstructions = initialInstructions ?? "";
		this.initialBypass = initialBypass ?? false;
		this.researchPromptPath = researchPromptPath ?? null;
		this.seriesNotePath = seriesNotePath ?? null;
		this.emptySeriesNotePath = emptySeriesNotePath ?? null;
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

		// A series note that contributed a prompt and/or default context notes gives
		// the user a one-click "just research it" path, so collapse the advanced
		// controls by default. Ad-hoc research needs them, so start expanded.
		this.collapsible = !!this.seriesNotePath;
		this.expanded = !this.collapsible;

		// Provenance tag: where the pre-filled prompt/notes came from, linked so the
		// user can open and edit that series note in the vault.
		if (this.seriesNotePath) {
			const seriesPath = this.seriesNotePath;
			const tag = contentEl.createDiv({cls: "whisper-cal-research-series-tag"});
			setIcon(tag.createSpan({cls: "whisper-cal-research-series-tag-icon"}), "git-branch");
			tag.createSpan({
				cls: "whisper-cal-research-series-tag-text",
				text: "Using the meeting series prompt from",
			});
			const link = tag.createEl("a", {
				cls: "whisper-cal-research-series-tag-link",
				text: seriesPath.replace(/\.md$/, ""),
				href: "#",
			});
			link.setAttr("aria-label", `Open ${seriesPath}`);
			link.addEventListener("click", (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(seriesPath, "", true);
			});
		}

		// Tip (blank-modal case only): a series note exists but has no prep yet, so
		// point the user to it. Mutually exclusive with the provenance tag above.
		if (this.emptySeriesNotePath) {
			const seriesPath = this.emptySeriesNotePath;
			const tip = contentEl.createDiv({cls: "whisper-cal-research-series-tip"});
			setIcon(tip.createSpan({cls: "whisper-cal-research-series-tip-icon"}), "lightbulb");
			const text = tip.createSpan({cls: "whisper-cal-research-series-tip-text"});
			text.appendText("Did you know you can save custom LLM prompts specific to this meeting series? Open ");
			const link = text.createEl("a", {
				cls: "whisper-cal-research-series-tag-link",
				text: seriesPath.replace(/\.md$/, "").split("/").pop() ?? seriesPath,
				href: "#",
			});
			link.setAttr("aria-label", `Open ${seriesPath}`);
			link.addEventListener("click", (e) => {
				e.preventDefault();
				// Opening the series note to edit its prompt means the user isn't
				// researching right now — dismiss the modal so it's out of the way.
				void this.app.workspace.openLinkText(seriesPath, "", true);
				this.close();
			});
			text.appendText(" to add them.");
		}

		// Selected context-note chips \u2014 shown in both states so the pre-filled
		// context is always visible; the picker that edits them lives in advanced.
		this.chipsEl = contentEl.createDiv({cls: "whisper-cal-research-chips"});
		this.renderChips();

		// Disclosure toggle (series mode only): reveals the note picker and prompt
		// editor for the occasional custom run.
		if (this.collapsible) {
			const toggle = contentEl.createDiv({cls: "whisper-cal-research-toggle"});
			this.toggleChevron = toggle.createSpan({cls: "whisper-cal-research-toggle-chevron"});
			this.toggleText = toggle.createSpan({cls: "whisper-cal-research-toggle-text"});
			toggle.addEventListener("click", () => {
				this.expanded = !this.expanded;
				this.applyDisclosure();
				if (this.expanded) setTimeout(() => this.searchInput.focus(), 0);
			});
			addActivateOnKey(toggle);
		}

		// Advanced controls: note picker (search + results) and prompt editor.
		this.advancedEl = contentEl.createDiv({cls: "whisper-cal-research-advanced"});

		// Purpose line: the picker is easy to mistake for a plain file list, so spell
		// out that the checked notes become context fed to the research prompt.
		this.advancedEl.createDiv({
			cls: "whisper-cal-research-picker-help",
			text: "Pick vault notes to feed as context to the research prompt below. Leave empty to research from the meeting note alone.",
		});

		// Search + folder scope on one row. The folder dropdown fixes the picker
		// otherwise showing only the vault's first folder (newest-first, capped list).
		const controls = this.advancedEl.createDiv({cls: "whisper-cal-research-controls"});
		this.searchInput = controls.createEl("input", {
			type: "text",
			placeholder: "Search vault notes\u2026",
			cls: "whisper-cal-research-search",
		});
		this.searchInput.addEventListener("input", () => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => this.renderResults(), 150);
		});

		const folderSelect = controls.createEl("select", {cls: "whisper-cal-research-folder"});
		folderSelect.createEl("option", {text: "All folders", value: ""});
		for (const folder of this.collectFolders()) {
			folderSelect.createEl("option", {text: folder, value: folder});
		}
		folderSelect.addEventListener("change", () => {
			this.folderFilter = folderSelect.value;
			this.renderResults();
		});

		// Sort control — the standard Obsidian file-explorer pattern: a sort icon that
		// opens a menu of checkmarked ordering options.
		const sortBtn = controls.createSpan({cls: "clickable-icon whisper-cal-research-sort"});
		setIcon(sortBtn, "arrow-up-narrow-wide");
		sortBtn.setAttr("aria-label", "Change sort order");
		sortBtn.addEventListener("click", (e) => this.openSortMenu(e));

		this.resultsEl = this.advancedEl.createDiv({cls: "whisper-cal-research-results"});
		this.renderResults();

		// Bypass prompt checkbox: when checked the textarea replaces the prompt file
		// outright instead of appending to it.
		const bypassRow = this.advancedEl.createDiv({cls: "whisper-cal-research-bypass"});
		this.bypassCheckbox = bypassRow.createEl("input", {type: "checkbox"});
		this.bypassCheckbox.id = "whisper-cal-bypass-prompt";
		bypassRow.createEl("label", {
			text: "Use as direct prompt (bypass prompt file)",
			attr: {"for": "whisper-cal-bypass-prompt"},
		});
		// Link the default prompt file so the user can see exactly which prompt runs
		// when bypass is off. Opened in the vault, dismissing the modal.
		if (this.researchPromptPath) {
			const promptPath = this.researchPromptPath;
			const link = bypassRow.createEl("a", {
				cls: "whisper-cal-research-prompt-link",
				text: "View default prompt",
				href: "#",
			});
			link.setAttr("aria-label", `Open ${promptPath}`);
			link.addEventListener("click", (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(promptPath, "", true);
				this.close();
			});
		}
		this.bypassCheckbox.addEventListener("change", () => this.updateBypassState());

		this.instructionsLabel = this.advancedEl.createEl("label", {
			text: "Prompt",
			cls: "whisper-cal-research-label",
		});
		this.instructionsEl = this.advancedEl.createEl("textarea", {
			placeholder: "Enter your research prompt\u2026",
			cls: "whisper-cal-research-instructions",
		});
		this.instructionsEl.rows = 6;
		// Clear the inline validation error as soon as the user types a prompt.
		this.instructionsEl.addEventListener("input", () => this.errorEl?.addClass("is-hidden"));
		// Seed from any series-note prep before resolving the label state.
		this.bypassCheckbox.checked = this.initialBypass;
		this.instructionsEl.value = this.initialInstructions;
		this.updateBypassState();

		// Buttons
		const btnRow = contentEl.createDiv({cls: "whisper-cal-research-buttons"});
		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		// Inline validation message (hidden until a blocked submit). Lives above the
		// buttons so it's visible without scrolling.
		this.errorEl = btnRow.createDiv({cls: "whisper-cal-research-error is-hidden"});

		this.submitBtn = btnRow.createEl("button", {text: "Research", cls: "mod-cta"});
		this.submitBtn.addEventListener("click", () => {
			// Bypass mode replaces the prompt file, so an empty direct prompt would run
			// the LLM with nothing to do — block it visibly instead of silently
			// dismissing (which read as Cancel). Normal mode with everything empty is
			// valid: "research from the meeting note alone" per the picker help text.
			if (this.bypassCheckbox.checked && this.instructionsEl.value.trim().length === 0) {
				this.errorEl.setText("Enter a direct prompt, or uncheck bypass to use the research prompt file.");
				this.errorEl.removeClass("is-hidden");
				this.instructionsEl.focus();
				return;
			}
			this.submitted = true;
			this.close();
		});

		this.applyDisclosure();
		// Series mode opens collapsed: focus the CTA so Enter researches immediately.
		// Ad-hoc mode focuses the search box to start picking context notes.
		setTimeout(() => {
			if (this.collapsible && !this.expanded) this.submitBtn.focus();
			else this.searchInput.focus();
		}, 10);
	}

	private applyDisclosure(): void {
		this.advancedEl.toggleClass("is-hidden", !this.expanded);
		if (this.collapsible) {
			setIcon(this.toggleChevron, this.expanded ? "chevron-down" : "chevron-right");
			this.toggleText.setText(this.expanded
				? "Hide options"
				: "Add context notes or customize the prompt");
		}
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
			remove.setAttribute("aria-label", "Remove note");
			remove.addEventListener("click", () => {
				this.selected.delete(path);
				this.renderChips();
				this.renderResults();
			});
			addActivateOnKey(remove);
		}
	}

	private updateBypassState(): void {
		this.errorEl?.addClass("is-hidden");
		const bypass = this.bypassCheckbox.checked;
		this.instructionsLabel.setText(bypass
			? "Direct prompt (replaces the prompt file)"
			: "Additional instructions (appended to the research prompt)");
	}

	/**
	 * Distinct folder paths that contain at least one note, at any depth, sorted
	 * alphabetically. Every ancestor folder is included so a top-level folder whose
	 * notes live only in subfolders still shows up (and prefix-filters correctly).
	 */
	private collectFolders(): string[] {
		const folders = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			let parent = file.parent;
			while (parent && parent.path && parent.path !== "/") {
				folders.add(parent.path);
				parent = parent.parent;
			}
		}
		return [...folders].sort((a, b) => a.localeCompare(b));
	}

	/**
	 * Open the sort menu, mirroring Obsidian's file-explorer options (name / modified
	 * time / created time, each direction), with the active mode checkmarked.
	 */
	private openSortMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const option = (title: string, mode: SortMode): void => {
			menu.addItem((item) => item
				.setTitle(title)
				.setChecked(this.sortMode === mode)
				.onClick(() => {
					this.sortMode = mode;
					this.renderResults();
				}));
		};
		option("File name (A to Z)", "name-asc");
		option("File name (Z to A)", "name-desc");
		menu.addSeparator();
		option("Modified time (new to old)", "mtime-desc");
		option("Modified time (old to new)", "mtime-asc");
		menu.addSeparator();
		option("Created time (new to old)", "ctime-desc");
		option("Created time (old to new)", "ctime-asc");
		menu.showAtMouseEvent(evt);
	}

	/** Compare two files by the active sort mode (selected-first grouping is applied separately). */
	private compareBySort(a: TFile, b: TFile): number {
		switch (this.sortMode) {
			case "name-asc": return a.basename.localeCompare(b.basename);
			case "name-desc": return b.basename.localeCompare(a.basename);
			case "mtime-asc": return a.stat.mtime - b.stat.mtime;
			case "mtime-desc": return b.stat.mtime - a.stat.mtime;
			case "ctime-asc": return a.stat.ctime - b.stat.ctime;
			case "ctime-desc": return b.stat.ctime - a.stat.ctime;
		}
	}

	private renderResults(): void {
		this.resultsEl.empty();
		const query = this.searchInput.value.toLowerCase();
		const folder = this.folderFilter;
		const allFiles = this.app.vault.getMarkdownFiles();

		// Filter by folder scope + search query.
		const matches: TFile[] = [];
		for (const file of allFiles) {
			if (folder && !file.path.startsWith(`${folder}/`)) continue;
			if (!query || file.path.toLowerCase().includes(query) || file.basename.toLowerCase().includes(query)) {
				matches.push(file);
			}
		}
		// Selected items first, then by the chosen sort mode (default: newest modified).
		matches.sort((a, b) => {
			const aSelected = this.selected.has(a.path) ? 0 : 1;
			const bSelected = this.selected.has(b.path) ? 0 : 1;
			if (aSelected !== bSelected) return aSelected - bSelected;
			return this.compareBySort(a, b);
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
		} else if (matches.length > limited.length) {
			this.resultsEl.createDiv({
				text: `Showing ${limited.length} of ${matches.length} — search or pick a folder to narrow`,
				cls: "whisper-cal-research-more",
			});
		}
	}

	onClose(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		const bypass = this.bypassCheckbox.checked;
		const text = this.instructionsEl.value.trim();
		// The submit handler already blocks the one invalid case (bypass mode with an
		// empty prompt), so any submitted close is a valid result — including the
		// deliberately-empty normal-mode case (research from the meeting note alone).
		const result: ResearchResult | null = this.submitted
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
