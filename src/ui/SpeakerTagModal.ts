import {Modal, App, TFolder, TFile, Notice} from "obsidian";
import type {ProposedSpeakerMapping} from "../services/SpeakerTagParser";
import {getMarkdownFilesRecursive, ensureFolder} from "../utils/vault";
import {renderModalHeader} from "./ModalHeader";

export interface SpeakerTagDecision {
	speakerId: string;
	originalName: string;
	confirmedName: string;
	confidence: string;
	evidence: string;
}

interface PersonEntry {
	name: string;
	notePath: string;
}

/**
 * Modal for reviewing and approving proposed speaker tag mappings.
 * Returns the decisions array, or null if cancelled.
 */
export class SpeakerTagModal extends Modal {
	private resolve: ((value: SpeakerTagDecision[] | null) => void) | null = null;
	private submitted = false;
	private mappings: ProposedSpeakerMapping[];
	private meetingTitle: string;
	private meetingSubtitle: string;
	private inputs: HTMLInputElement[] = [];
	private peopleFolderPath: string;
	private people: PersonEntry[] = [];
	private microphoneUser: string;
	private micMappings: ProposedSpeakerMapping[] = [];
	private speakerBlocks: Map<string, string[]>;

	constructor(app: App, mappings: ProposedSpeakerMapping[], title: string, subtitle: string, peopleFolderPath: string, microphoneUser: string, transcriptContent: string) {
		super(app);
		this.microphoneUser = microphoneUser;
		// Keep original index order so speakers appear in transcript sequence
		const sorted = [...mappings].sort((a, b) => a.index - b.index);
		// Separate out the microphone user — they're always the same person
		if (microphoneUser) {
			const micLower = microphoneUser.toLowerCase();
			this.micMappings = sorted.filter(m => m.proposedName.toLowerCase() === micLower);
			this.mappings = sorted.filter(m => m.proposedName.toLowerCase() !== micLower);
		} else {
			this.mappings = sorted;
		}
		this.meetingTitle = title;
		this.meetingSubtitle = subtitle;
		this.peopleFolderPath = peopleFolderPath;
		this.people = this.buildPeopleList();
		this.speakerBlocks = this.parseSpeakerBlocks(transcriptContent);
	}

	/** Parse transcript body into per-speaker blocks for the excerpt panel. */
	private parseSpeakerBlocks(content: string): Map<string, string[]> {
		const map = new Map<string, string[]>();
		// Strip YAML frontmatter
		const firstFence = content.indexOf("---");
		if (firstFence < 0) return map;
		const secondFence = content.indexOf("---", firstFence + 3);
		if (secondFence < 0) return map;
		const body = content.slice(secondFence + 3);

		// Match block starts: **Speaker Name** [HH:MM:SS]
		const re = /^\*\*(.+?)\*\*\s*\[[\d:]+\]/gm;
		const starts: {name: string; pos: number}[] = [];
		let m: RegExpExecArray | null;
		while ((m = re.exec(body)) !== null) {
			starts.push({name: m[1]!, pos: m.index});
		}

		for (let i = 0; i < starts.length; i++) {
			const {name, pos} = starts[i]!;
			const end = i + 1 < starts.length ? starts[i + 1]!.pos : body.length;
			const block = body.slice(pos, end).trim();
			if (!map.has(name)) map.set(name, []);
			map.get(name)!.push(block);
		}

		return map;
	}

	/** Render transcript blocks into the excerpt panel, stripping the bold speaker prefix. */
	private renderExcerpt(container: HTMLElement, blocks: string[]): void {
		for (const block of blocks) {
			const lines = block.split("\n");
			const firstLine = lines[0] ?? "";
			// Strip leading **Speaker Name** to show just the timestamp
			const stripped = firstLine.replace(/^\*\*.+?\*\*\s*/, "");
			const bodyLines = lines.slice(1).join("\n").trim();

			const blockEl = container.createDiv({cls: "whisper-cal-excerpt-block"});
			blockEl.createDiv({cls: "whisper-cal-excerpt-ts", text: stripped});
			if (bodyLines) {
				blockEl.createDiv({cls: "whisper-cal-excerpt-text", text: bodyLines});
			}
		}
	}

	private buildPeopleList(): PersonEntry[] {
		if (!this.peopleFolderPath) return [];
		const folder = this.app.vault.getAbstractFileByPath(this.peopleFolderPath);
		if (!(folder instanceof TFolder)) return [];

		const files = getMarkdownFilesRecursive(folder);
		const entries: PersonEntry[] = [];
		for (const file of files) {
			const name = file.basename;
			entries.push({name, notePath: file.path});
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		return entries;
	}

	prompt(): Promise<SpeakerTagDecision[] | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass("whisper-cal-speaker-tag-modal");

		// Prevent backdrop click and window blur from closing the modal
		this.containerEl.querySelector(".modal-bg")
			?.addEventListener("click", (e) => e.stopImmediatePropagation());

		renderModalHeader(contentEl, this.meetingTitle, this.meetingSubtitle);

		const rows = contentEl.createDiv({cls: "whisper-cal-speaker-tag-rows"});

		for (const mapping of this.mappings) {
			const container = rows.createDiv({cls: "whisper-cal-speaker-tag-container"});
			const row = container.createDiv({cls: "whisper-cal-speaker-tag-row"});

			// Left: disclosure toggle + stub name + line count
			const left = row.createDiv({cls: "whisper-cal-speaker-tag-left"});

			const blocks = this.speakerBlocks.get(mapping.originalName) ?? [];
			const hasExcerpt = blocks.length > 0;

			if (hasExcerpt) {
				const toggle = left.createSpan({cls: "whisper-cal-speaker-tag-toggle is-collapsed"});
				toggle.setAttribute("aria-label", "Show transcript lines");
				const excerptEl = container.createDiv({cls: "whisper-cal-speaker-tag-excerpt whisper-cal-hidden"});
				this.renderExcerpt(excerptEl, blocks);

				const flipToggle = () => {
					const hidden = excerptEl.hasClass("whisper-cal-hidden");
					excerptEl.toggleClass("whisper-cal-hidden", !hidden);
					toggle.toggleClass("is-collapsed", !hidden);
				};
				toggle.addEventListener("click", flipToggle);
			}

			left.createSpan({
				cls: "whisper-cal-speaker-tag-stub",
				text: mapping.originalName,
			});
			left.createSpan({
				cls: "whisper-cal-speaker-tag-lines",
				text: `(${mapping.lineCount} line${mapping.lineCount !== 1 ? "s" : ""})`,
			});

			// Right: arrow + input with autocomplete
			const right = row.createDiv({cls: "whisper-cal-speaker-tag-right"});
			right.createSpan({cls: "whisper-cal-speaker-tag-arrow", text: "\u2192"});

			const wrapper = right.createDiv({cls: "whisper-cal-speaker-tag-input-wrapper"});
			const input = wrapper.createEl("input", {
				type: "text",
				cls: "whisper-cal-speaker-tag-input",
				attr: {placeholder: "Speaker name", autocomplete: "off"},
			});
			input.value = mapping.proposedName;
			this.inputs.push(input);

			if (this.people.length > 0) {
				this.attachAutocomplete(wrapper, input, mapping.proposedName);
			}

			// Confidence + evidence below input
			const detail = row.createDiv({cls: "whisper-cal-speaker-tag-detail"});
			if (mapping.confidence) {
				const badgeCls = `whisper-cal-badge-${mapping.confidence.toLowerCase()}`;
				detail.createSpan({
					cls: `whisper-cal-speaker-tag-badge ${badgeCls}`,
					text: mapping.confidence,
				});
			}
			if (mapping.evidence) {
				detail.createSpan({
					cls: "whisper-cal-speaker-tag-evidence",
					text: mapping.confidence ? ` \u00B7 ${mapping.evidence}` : mapping.evidence,
				});
			}
			if (!mapping.confidence && !mapping.evidence) {
				detail.createSpan({
					cls: "whisper-cal-speaker-tag-evidence",
					text: "unresolved",
				});
			}
		}

		// Handle Enter on last input → Apply, Tab navigation is native
		for (let i = 0; i < this.inputs.length; i++) {
			this.inputs[i]!.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					if (i === this.inputs.length - 1) {
						this.submitted = true;
						this.close();
					} else {
						this.inputs[i + 1]!.focus();
					}
				}
			});
		}

		// Buttons
		const btnRow = contentEl.createDiv({cls: "whisper-cal-speaker-tag-buttons"});
		const cancelBtn = btnRow.createEl("button", {text: "Cancel"});
		cancelBtn.addEventListener("click", () => this.close());

		const applyBtn = btnRow.createEl("button", {text: "Apply", cls: "mod-cta"});
		applyBtn.addEventListener("click", () => {
			this.submitted = true;
			this.close();
		});

		// Focus first input
		setTimeout(() => {
			if (this.inputs.length > 0) {
				this.inputs[0]!.focus();
				this.inputs[0]!.select();
			}
		}, 10);
	}

	private attachAutocomplete(wrapper: HTMLElement, input: HTMLInputElement, originalProposed: string): void {
		const dropdown = wrapper.createDiv({cls: "whisper-cal-autocomplete-dropdown whisper-cal-hidden"});
		let selectedIdx = -1;
		let userEdited = !originalProposed;

		const showDropdown = (visible: boolean) => dropdown.toggleClass("whisper-cal-hidden", !visible);
		const isDropdownVisible = () => !dropdown.hasClass("whisper-cal-hidden");

		input.addEventListener("input", () => {
			userEdited = input.value.trim() !== originalProposed;
		});

		const updateDropdown = (): void => {
			const query = input.value.trim().toLowerCase();
			dropdown.empty();
			selectedIdx = -1;

			// Only show autocomplete when user has edited away from the LLM proposal, or it was empty
			if (!userEdited || !query) {
				showDropdown(false);
				return;
			}

			const matches = this.people.filter(p =>
				p.name.toLowerCase().includes(query)
			).slice(0, 8);

			const exactMatch = this.people.some(p =>
				p.name.toLowerCase() === query
			);

			if (matches.length === 0 && !this.peopleFolderPath) {
				showDropdown(false);
				return;
			}

			for (const person of matches) {
				const item = dropdown.createDiv({
					cls: "whisper-cal-autocomplete-item",
					text: person.name,
				});
				item.addEventListener("mousedown", (e) => {
					e.preventDefault();
					input.value = person.name;
					userEdited = false;
					showDropdown(false);
				});
			}

			// "+ Create note" option when typed name doesn't exactly match
			if (this.peopleFolderPath && query && !exactMatch) {
				const createItem = dropdown.createDiv({
					cls: "whisper-cal-autocomplete-item whisper-cal-autocomplete-create",
				});
				createItem.createSpan({text: "+ Create note: "});
				createItem.createSpan({
					cls: "whisper-cal-autocomplete-create-name",
					text: input.value.trim(),
				});
				createItem.addEventListener("mousedown", (e) => {
					e.preventDefault();
					void this.createPersonNote(input.value.trim(), input);
					showDropdown(false);
				});
			}

			showDropdown(matches.length > 0 || (!exactMatch && !!this.peopleFolderPath));
		};

		const highlightItem = (items: HTMLElement[]): void => {
			items.forEach((el, i) => {
				el.toggleClass("is-selected", i === selectedIdx);
			});
		};

		input.addEventListener("input", updateDropdown);

		input.addEventListener("keydown", (e) => {
			const items = Array.from(dropdown.querySelectorAll<HTMLElement>(".whisper-cal-autocomplete-item"));
			if (!isDropdownVisible() || items.length === 0) return;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
				highlightItem(items);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				selectedIdx = Math.max(selectedIdx - 1, 0);
				highlightItem(items);
			} else if (e.key === "Enter" && selectedIdx >= 0) {
				e.preventDefault();
				e.stopPropagation();
				items[selectedIdx]!.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
			} else if (e.key === "Escape") {
				showDropdown(false);
				selectedIdx = -1;
			}
		});

		input.addEventListener("blur", () => {
			// Delay to allow mousedown on dropdown items
			setTimeout(() => showDropdown(false), 150);
		});

		input.addEventListener("focus", () => {
			if (input.value.trim()) updateDropdown();
		});
	}

	private async createPersonNote(name: string, input: HTMLInputElement): Promise<void> {
		if (!this.peopleFolderPath || !name) return;

		const notePath = `${this.peopleFolderPath}/${name}.md`;
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) {
			new Notice(`Note already exists: ${name}`);
			return;
		}

		try {
			await ensureFolder(this.app, this.peopleFolderPath);
			await this.app.vault.create(notePath, `---\nfull_name: "${name}"\n---\n`);
			// Refresh people list
			this.people = this.buildPeopleList();
			input.value = name;
			new Notice(`Created: ${notePath}`);
		} catch (err) {
			console.error("[WhisperCal] Failed to create person note", err);
			new Notice(`Failed to create note: ${String(err)}`);
		}
	}

	onClose(): void {
		const decisions: SpeakerTagDecision[] | null = this.submitted
			? [
				// Auto-confirm microphone user mappings
				...this.micMappings.map(m => ({
					speakerId: m.speakerId,
					originalName: m.originalName,
					confirmedName: this.microphoneUser,
					confidence: m.confidence,
					evidence: m.evidence,
				})),
				// User-confirmed mappings from the modal
				...this.mappings.map((m, i) => ({
					speakerId: m.speakerId,
					originalName: m.originalName,
					confirmedName: this.inputs[i]?.value.trim() ?? "",
					confidence: m.confidence,
					evidence: m.evidence,
				})),
			]
			: null;

		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(decisions);
				this.resolve = null;
			}
		}, 0);
	}
}
