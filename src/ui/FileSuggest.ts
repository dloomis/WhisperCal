import {AbstractInputSuggest, App, TFile} from "obsidian";

/**
 * Autocomplete dropdown for .md files in the vault.
 * Attach to a text input to provide file path suggestions.
 */
export class FileSuggest extends AbstractInputSuggest<TFile> {
	private textInputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.textInputEl = inputEl;
	}

	getSuggestions(query: string): TFile[] {
		const lowerQuery = query.toLowerCase();
		return this.app.vault.getMarkdownFiles()
			.filter(file => file.path.toLowerCase().includes(lowerQuery))
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, 20);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		this.textInputEl.value = file.path;
		this.textInputEl.trigger("input");
		this.close();
	}
}
