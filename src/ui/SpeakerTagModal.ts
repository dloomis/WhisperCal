import {Modal, App, TFolder, TFile, Notice, setIcon, normalizePath} from "obsidian";
import {sanitizeFilename, yamlEscape} from "../utils/sanitize";
import type {ProposedSpeakerMapping} from "../services/SpeakerTagParser";
import {getMarkdownFilesRecursive, ensureFolder} from "../utils/vault";
import {addActivateOnKey} from "../utils/a11y";
import {transcriptBody, findSpeakerLabels} from "../utils/transcript";
import {renderModalHeader} from "./ModalHeader";

/** Fallback clip length when the setting is unset (0). */
const DEFAULT_CLIP_SECONDS = 5;

export interface SpeakerTagDecision {
	speakerId: string;
	originalName: string;
	/** Diarizer stub label / voiceprint-sidecar key (e.g. "Speaker 2", "You"). Differs from
	 *  originalName on a re-tag review, where originalName is the current real-name body label.
	 *  Falls back to originalName when unset. */
	diarizerLabel?: string;
	confirmedName: string;
	confidence: string;
	evidence: string;
}

interface PersonEntry {
	name: string;
	notePath: string;
}

/**
 * Parse a transcript block's leading timestamp token into an offset in seconds.
 * Supports the Tome format "(15.739)" (seconds from zero) and the MacWhisper
 * format "[HH:MM:SS]" / "[MM:SS]". Returns null when no timestamp is recognized.
 */
function parseOffsetSeconds(ts: string): number | null {
	const paren = ts.match(/^\((\d+(?:\.\d+)?)\)/);
	if (paren) return parseFloat(paren[1]!);

	const bracket = ts.match(/^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/);
	if (bracket) {
		const h = bracket[1] ? parseInt(bracket[1], 10) : 0;
		const m = parseInt(bracket[2]!, 10);
		const s = parseInt(bracket[3]!, 10);
		return h * 3600 + m * 60 + s;
	}

	return null;
}

/** A contiguous run of one speaker's lines, with its audio span. */
interface ExcerptBlock {
	/** Block text including the leading **Speaker** label. */
	text: string;
	/** Playback start offset in seconds, or null if no timestamp parsed. */
	startOffset: number | null;
	/** Start offset of the next block (any speaker) — where this snippet ends. */
	endOffset: number | null;
}

/**
 * Modal for reviewing and approving proposed speaker tag mappings.
 * Returns the decisions array, or null if cancelled.
 */
export class SpeakerTagModal extends Modal {
	private resolve: ((value: SpeakerTagDecision[] | null) => void) | null = null;
	private submitted = false;
	/** Hides the currently-open autocomplete dropdown, if any (see Escape handling). */
	private dropdownDismisser: (() => void) | null = null;
	private mappings: ProposedSpeakerMapping[];
	private meetingTitle: string;
	private meetingSubtitle: string;
	private inputs: HTMLInputElement[] = [];
	private peopleFolderPath: string;
	private people: PersonEntry[] = [];
	private speakerBlocks: Map<string, ExcerptBlock[]>;
	private audioFile: TFile | null;
	private audioEl: HTMLAudioElement | null = null;
	/** Seconds to play per click; 0 = play the full snippet (until the next speaker). */
	private clipSeconds: number;
	/** Playback position (seconds) to pause at, set when a snippet is clicked. */
	private stopAt: number | null = null;
	/** True while we are seeking on the user's behalf, so manual seeks can be told apart. */
	private seekingForSnippet = false;
	/** Curated attendee names (from meeting_invitees) shown first in the dropdown. */
	private meetingInvitees: string[];

	constructor(app: App, mappings: ProposedSpeakerMapping[], title: string, subtitle: string, peopleFolderPath: string, transcriptContent: string, audioFile: TFile | null = null, clipSeconds = 0, meetingInvitees: string[] = []) {
		super(app);
		// Keep original index order so speakers appear in transcript sequence.
		// Show every speaker — including any the LLM proposed as the microphone user — so the
		// user can override a wrong mic guess (Rule 1's old "most lines" fallback frequently
		// mislabelled the host as the recorder).
		this.mappings = [...mappings].sort((a, b) => a.index - b.index);
		this.meetingTitle = title;
		this.meetingSubtitle = subtitle;
		this.peopleFolderPath = peopleFolderPath;
		this.people = this.buildPeopleList();
		this.speakerBlocks = this.parseSpeakerBlocks(transcriptContent);
		this.audioFile = audioFile;
		this.clipSeconds = clipSeconds;
		// Dedupe while preserving order.
		this.meetingInvitees = [...new Set(meetingInvitees.filter(Boolean))];
	}

	/** Parse transcript body into per-speaker blocks (with audio spans) for the excerpt panel. */
	private parseSpeakerBlocks(content: string): Map<string, ExcerptBlock[]> {
		const map = new Map<string, ExcerptBlock[]>();
		const body = transcriptBody(content);
		const starts = findSpeakerLabels(body);

		// First pass: build each block in global transcript order with its start offset.
		const ordered: {name: string; block: ExcerptBlock}[] = [];
		for (let i = 0; i < starts.length; i++) {
			const {name, pos} = starts[i]!;
			const end = i + 1 < starts.length ? starts[i + 1]!.pos : body.length;
			const text = body.slice(pos, end).trim();
			const firstLine = text.split("\n", 1)[0] ?? "";
			const startOffset = parseOffsetSeconds(firstLine.replace(/^\*\*.+?\*\*\s*/, ""));
			ordered.push({name, block: {text, startOffset, endOffset: null}});
		}

		// Second pass: a snippet ends where the next block (any speaker) begins.
		for (let i = 0; i < ordered.length; i++) {
			ordered[i]!.block.endOffset = ordered[i + 1]?.block.startOffset ?? null;
		}

		for (const {name, block} of ordered) {
			if (!map.has(name)) map.set(name, []);
			map.get(name)!.push(block);
		}

		return map;
	}

	/**
	 * Seek the player to a snippet and pause after a fixed clip length. We deliberately
	 * ignore the next speaker's timestamp: on short lines that boundary is a split-second
	 * away and used to cut the clip off almost immediately. Always playing a fixed window
	 * (the clip-length setting, default 5s) guarantees you actually hear the voice.
	 * Enforced by the timeupdate listener in onOpen.
	 */
	private playSnippet(start: number): void {
		if (!this.audioEl) return;
		const duration = this.clipSeconds > 0 ? this.clipSeconds : DEFAULT_CLIP_SECONDS;
		this.stopAt = start + duration;
		// Assigning currentTime the value it already holds fires no "seeked", which
		// would leave the flag latched: the user's next scrubber drag would then read
		// as a snippet seek and playback would stop dead at this stale stopAt.
		this.seekingForSnippet = Math.abs(this.audioEl.currentTime - start) >= 0.01;
		this.audioEl.currentTime = start;
		void this.audioEl.play();
	}

	/** Render transcript blocks into the excerpt panel, stripping the bold speaker prefix. */
	private renderExcerpt(container: HTMLElement, blocks: ExcerptBlock[]): void {
		for (const block of blocks) {
			const lines = block.text.split("\n");
			const firstLine = lines[0] ?? "";
			// Strip leading **Speaker Name** to show just the timestamp
			const stripped = firstLine.replace(/^\*\*.+?\*\*\s*/, "");
			const bodyLines = lines.slice(1).join("\n").trim();

			const blockEl = container.createDiv({cls: "whisper-cal-excerpt-block"});

			// When a recording is linked and the timestamp parses, make it a
			// one-click control that plays just this snippet in the in-modal player.
			if (this.audioEl && block.startOffset !== null) {
				const start = block.startOffset;
				const tsEl = blockEl.createDiv({cls: "whisper-cal-excerpt-ts is-playable"});
				const icon = tsEl.createSpan({cls: "whisper-cal-excerpt-play"});
				setIcon(icon, "play");
				tsEl.createSpan({text: stripped});
				tsEl.setAttribute("aria-label", "Play this snippet");
				tsEl.addEventListener("click", () => this.playSnippet(start));
				addActivateOnKey(tsEl);
			} else {
				blockEl.createDiv({cls: "whisper-cal-excerpt-ts", text: stripped});
			}

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

		// Focus sink — Obsidian's modal (or the browser) auto-focuses the first
		// focusable element on open, which for this modal is a name input whose
		// focus handler pops its dropdown open unprompted. A no-op focusable
		// element placed first in the DOM, and explicitly focused below, absorbs
		// that initial focus so nothing triggers until the user picks a field.
		const focusSink = contentEl.createDiv({
			cls: "whisper-cal-focus-sink",
			attr: {tabindex: "-1", "aria-hidden": "true"},
		});

		// Prevent backdrop click and window blur from closing the modal
		this.containerEl.querySelector(".modal-bg")
			?.addEventListener("click", (e) => e.stopImmediatePropagation());

		// Escape with an autocomplete dropdown open dismisses the dropdown, not the
		// modal — the modal's default Escape-to-close would discard all typed names.
		// (The input's own keydown handler also stops propagation; this scope
		// override covers the path where the keymap scope sees the key first.)
		this.scope.register([], "Escape", () => {
			if (this.dropdownDismisser) {
				this.dropdownDismisser();
				return false;
			}
			this.close();
			return false;
		});

		renderModalHeader(contentEl, this.meetingTitle, this.meetingSubtitle);

		// Pinned audio player — present only when the transcript links a recording.
		// Per-speaker timestamps seek this element so the user can hear who's speaking.
		if (this.audioFile) {
			this.audioEl = contentEl.createEl("audio", {cls: "whisper-cal-modal-audio"});
			this.audioEl.controls = true;
			this.audioEl.preload = "metadata";
			this.audioEl.src = this.app.vault.getResourcePath(this.audioFile);

			// Stop at the snippet boundary. timeupdate (not setTimeout) so the cut
			// point tracks actual playback position, immune to streaming latency.
			this.audioEl.addEventListener("timeupdate", () => {
				if (this.stopAt !== null && this.audioEl && this.audioEl.currentTime >= this.stopAt) {
					this.audioEl.pause();
					this.stopAt = null;
				}
			});
			// A seek we didn't initiate (user grabbed the scrubber) cancels the
			// pending snippet stop so manual playback runs unrestricted.
			this.audioEl.addEventListener("seeked", () => {
				if (this.seekingForSnippet) this.seekingForSnippet = false;
				else this.stopAt = null;
			});
		}

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
				addActivateOnKey(toggle);
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

			if (this.people.length > 0 || this.meetingInvitees.length > 0 || this.peopleFolderPath) {
				this.attachAutocomplete(wrapper, input);
			}

			// Confidence + evidence below input
			const detail = row.createDiv({cls: "whisper-cal-speaker-tag-detail"});
			if (mapping.source) {
				detail.createSpan({
					cls: `whisper-cal-speaker-tag-badge whisper-cal-badge-source-${mapping.source}`,
					text: mapping.source === "cache" ? "cache" : "LLM",
				});
			}
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

			// Closest voiceprint below the confident-match bar. Shown even alongside an LLM
			// guess so the user can see the acoustics also leaned toward this person.
			if (mapping.nearMatch) {
				const near = row.createDiv({cls: "whisper-cal-speaker-tag-detail whisper-cal-speaker-tag-nearmatch"});
				near.createSpan({
					cls: "whisper-cal-speaker-tag-badge whisper-cal-badge-nearmatch",
					text: "closest",
				});
				near.createSpan({
					cls: "whisper-cal-speaker-tag-evidence",
					text: ` · ${mapping.nearMatch.name} · cosine ${mapping.nearMatch.cosine.toFixed(3)}`,
				});
			}
		}

		// Handle Enter on last input → Apply, Tab navigation is native
		for (let i = 0; i < this.inputs.length; i++) {
			this.inputs[i]!.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					// Belt-and-braces: if this row's autocomplete dropdown is open with a
					// highlighted suggestion, this Enter belongs to the dropdown (it should
					// have stopped propagation already) — never treat it as submit/next.
					const dd = this.inputs[i]!.parentElement?.querySelector(".whisper-cal-autocomplete-dropdown");
					if (dd && !dd.classList.contains("whisper-cal-hidden") && dd.querySelector(".is-selected")) {
						return;
					}
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

		// Park focus off the name fields (deferred so it wins over any auto-focus
		// the modal framework applies synchronously during open). Prefer the
		// audio player — a real, visible control that triggers nothing — and fall
		// back to the off-screen sink when there's no recording. Either way no
		// name field is focused, so no dropdown opens until the user picks one.
		setTimeout(() => (this.audioEl ?? focusSink).focus({preventScroll: true}), 0);
	}

	private attachAutocomplete(wrapper: HTMLElement, input: HTMLInputElement): void {
		const dropdown = wrapper.createDiv({cls: "whisper-cal-autocomplete-dropdown whisper-cal-hidden"});
		let selectedIdx = -1;

		// Track the open dropdown at modal level so the Escape scope override can
		// dismiss it instead of closing the whole modal (which would discard every
		// typed name).
		const hideDropdown = (): void => {
			dropdown.addClass("whisper-cal-hidden");
			selectedIdx = -1;
			if (this.dropdownDismisser === hideDropdown) this.dropdownDismisser = null;
		};
		const showDropdown = (visible: boolean): void => {
			if (!visible) {
				hideDropdown();
				return;
			}
			dropdown.removeClass("whisper-cal-hidden");
			this.dropdownDismisser = hideDropdown;
		};
		const isDropdownVisible = () => !dropdown.hasClass("whisper-cal-hidden");

		const updateDropdown = (): void => {
			const query = input.value.trim().toLowerCase();
			dropdown.empty();
			selectedIdx = -1;

			// Merge candidates: meeting invitees first (the curated, expected attendees),
			// then broader people-folder matches. An empty query lists all invitees so the
			// field behaves as a prefilled dropdown; typing filters across both sets.
			// Invitees are bounded and never truncated (the list scrolls); only the much
			// larger people folder is capped.
			const PEOPLE_LIMIT = 10;
			const seen = new Set<string>();
			const invitees: string[] = [];
			const others: string[] = [];
			const consider = (name: string, target: string[]) => {
				const key = name.toLowerCase();
				if (seen.has(key)) return;
				if (query && !key.includes(query)) return;
				seen.add(key);
				target.push(name);
			};
			for (const name of this.meetingInvitees) consider(name, invitees);
			if (query) {
				for (const person of this.people) consider(person.name, others);
			}

			const candidates = [
				...invitees.map(name => ({name, invitee: true})),
				...others.slice(0, PEOPLE_LIMIT).map(name => ({name, invitee: false})),
			];
			const exactMatch = query.length > 0 && seen.has(query);

			for (const cand of candidates) {
				const item = dropdown.createDiv({cls: "whisper-cal-autocomplete-item"});
				item.createSpan({text: cand.name});
				if (cand.invitee) {
					item.createSpan({cls: "whisper-cal-autocomplete-tag", text: "invitee"});
				}
				item.addEventListener("mousedown", (e) => {
					e.preventDefault();
					input.value = cand.name;
					showDropdown(false);
				});
			}

			// "+ Create note" option when the typed name doesn't exactly match a known person.
			const hasCreate = !!this.peopleFolderPath && !!query && !exactMatch;
			if (hasCreate) {
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

			showDropdown(candidates.length > 0 || hasCreate);
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
				// stopImmediatePropagation (not stopPropagation) so the row's own
				// second keydown listener — the Apply/next-field submit handler on the
				// SAME element — doesn't also fire. Otherwise Enter-selecting a
				// suggestion on the last row would instantly Apply the whole modal.
				e.stopImmediatePropagation();
				items[selectedIdx]!.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
			} else if (e.key === "Escape") {
				// This Escape belongs to the dropdown — keep it away from the modal's
				// own Escape-to-close keymap handler.
				e.preventDefault();
				e.stopPropagation();
				showDropdown(false);
			}
		});

		input.addEventListener("blur", () => {
			// Delay to allow mousedown on dropdown items
			setTimeout(() => showDropdown(false), 150);
		});

		// Open the dropdown on click, not focus. Focus events fired for
		// programmatic .focus() calls are still trusted, so a focus listener
		// can't distinguish the modal's initial auto-focus (or Enter-to-next
		// navigation) from the user clicking into the field — which made the
		// dropdown flash open on load. A click can only come from the user.
		input.addEventListener("click", () => {
			if (!isDropdownVisible()) updateDropdown();
		});

		// Caret affordance signals this is a dropdown and toggles it.
		const caret = wrapper.createDiv({cls: "whisper-cal-autocomplete-caret"});
		setIcon(caret, "chevron-down");
		caret.addEventListener("mousedown", (e) => {
			e.preventDefault();
			if (isDropdownVisible()) {
				showDropdown(false);
			} else {
				input.focus();
				updateDropdown();
			}
		});
	}

	private async createPersonNote(name: string, input: HTMLInputElement): Promise<void> {
		if (!this.peopleFolderPath || !name) return;

		// The name is LLM-proposed/user-typed — sanitize before it becomes a path
		// segment, and escape before it lands inside quoted YAML.
		const notePath = normalizePath(`${this.peopleFolderPath}/${sanitizeFilename(name)}.md`);
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) {
			new Notice(`Note already exists: ${name}`);
			return;
		}

		try {
			await ensureFolder(this.app, this.peopleFolderPath);
			await this.app.vault.create(notePath, `---\nfull_name: "${yamlEscape(name)}"\n---\n`);
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
			? this.mappings.map((m, i) => ({
				speakerId: m.speakerId,
				originalName: m.originalName,
				diarizerLabel: m.diarizerLabel,
				confirmedName: this.inputs[i]?.value.trim() ?? "",
				confidence: m.confidence,
				evidence: m.evidence,
			}))
			: null;

		// Stop playback before tearing down the modal DOM.
		this.audioEl?.pause();
		this.audioEl = null;

		this.contentEl.empty();
		setTimeout(() => {
			if (this.resolve) {
				this.resolve(decisions);
				this.resolve = null;
			}
		}, 0);
	}
}
