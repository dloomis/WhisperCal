import {Modal, App} from "obsidian";
import type {ProposedSpeakerMapping} from "../services/SpeakerTagParser";

export interface SpeakerTagDecision {
	speakerId: string;
	originalName: string;
	confirmedName: string;
	confidence: string;
	evidence: string;
}

/**
 * Modal for reviewing and approving proposed speaker tag mappings.
 * Returns the decisions array, or null if cancelled.
 */
export class SpeakerTagModal extends Modal {
	private resolve: ((value: SpeakerTagDecision[] | null) => void) | null = null;
	private submitted = false;
	private mappings: ProposedSpeakerMapping[];
	private title: string;
	private inputs: HTMLInputElement[] = [];

	constructor(app: App, mappings: ProposedSpeakerMapping[], title: string) {
		super(app);
		// Sort by line count descending
		this.mappings = [...mappings].sort((a, b) => b.lineCount - a.lineCount);
		this.title = title;
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

		contentEl.createEl("h3", {text: "Tag speakers"});
		contentEl.createEl("p", {
			cls: "whisper-cal-speaker-tag-subtitle",
			text: `${this.title} \u00B7 ${this.mappings.length} speaker${this.mappings.length !== 1 ? "s" : ""}`,
		});

		const rows = contentEl.createDiv({cls: "whisper-cal-speaker-tag-rows"});

		for (const mapping of this.mappings) {
			const row = rows.createDiv({cls: "whisper-cal-speaker-tag-row"});

			// Left: stub name + line count
			const left = row.createDiv({cls: "whisper-cal-speaker-tag-left"});
			left.createSpan({
				cls: "whisper-cal-speaker-tag-stub",
				text: mapping.originalName,
			});
			left.createSpan({
				cls: "whisper-cal-speaker-tag-lines",
				text: `(${mapping.lineCount} line${mapping.lineCount !== 1 ? "s" : ""})`,
			});

			// Right: arrow + input
			const right = row.createDiv({cls: "whisper-cal-speaker-tag-right"});
			right.createSpan({cls: "whisper-cal-speaker-tag-arrow", text: "\u2192"});

			const input = right.createEl("input", {
				type: "text",
				cls: "whisper-cal-speaker-tag-input",
				attr: {placeholder: "Speaker name"},
			});
			input.value = mapping.proposedName;
			this.inputs.push(input);

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

	onClose(): void {
		const decisions: SpeakerTagDecision[] | null = this.submitted
			? this.mappings.map((m, i) => ({
				speakerId: m.speakerId,
				originalName: m.originalName,
				confirmedName: this.inputs[i]?.value.trim() ?? "",
				confidence: m.confidence,
				evidence: m.evidence,
			}))
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
