import type { ComposerCompletionPopup } from '$lib/chat/composer/completion-popup.js';
import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import { searchSnippetNames } from '$lib/snippets/search-snippets.js';
import { SelectableSnippetCatalog } from '$lib/snippets/selectable-snippet-catalog.svelte.js';
import type { SelectableSnippet } from '$lib/snippets/selectable-snippet.js';
import type { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';

interface SnippetCommandMenuStateOptions {
	snippets: SnippetsStore;
	preambles: PreamblesStore;
	get visible(): boolean;
	get query(): string;
	/** Expansion needs the chat's project; without it only name completion is offered. */
	get contextAvailable(): boolean;
	onInsert(snippet: SelectableSnippet): void;
	onComplete(snippet: SelectableSnippet): void;
	onClose(): void;
}

/** Filtering, highlight, and keyboard policy for the `/s` snippet command menu. */
export class SnippetCommandMenuState {
	readonly listId: string;
	readonly catalog: SelectableSnippetCatalog;
	readonly #idPrefix: string;
	readonly #options: SnippetCommandMenuStateOptions;
	// Scoped to the query it was chosen under, so typing resets to the best match.
	#highlight = $state<{ query: string; key: string } | null>(null);

	// The menu completes a command name, so template text never matches.
	#filteredSnippets = $derived.by(() =>
		searchSnippetNames(this.catalog.items, this.#options.query),
	);
	#highlightedIndex = $derived.by(() => {
		const current = this.#highlight;
		const index =
			current?.query === this.#options.query
				? this.#filteredSnippets.findIndex((snippet) => snippet.key === current.key)
				: -1;
		return index >= 0 ? index : this.#filteredSnippets.length > 0 ? 0 : -1;
	});
	#highlightedSnippet = $derived(this.#filteredSnippets[this.#highlightedIndex] ?? null);

	constructor(idPrefix: string, options: SnippetCommandMenuStateOptions) {
		this.#idPrefix = idPrefix;
		this.listId = `${idPrefix}-snippet-command-list`;
		this.#options = options;
		this.catalog = new SelectableSnippetCatalog(options.snippets, options.preambles);
	}

	get filteredSnippets(): readonly SelectableSnippet[] {
		return this.#filteredSnippets;
	}

	get highlightedIndex(): number {
		return this.#highlightedIndex;
	}

	get highlightedSnippet(): SelectableSnippet | null {
		return this.#highlightedSnippet;
	}

	get contextAvailable(): boolean {
		return this.#options.contextAvailable;
	}

	/** Present only while the listbox is rendered, so `aria-controls` never dangles. */
	get completionPopup(): ComposerCompletionPopup | null {
		if (!this.#options.visible || this.#filteredSnippets.length === 0) return null;
		const snippet = this.#highlightedSnippet;
		return { listId: this.listId, activeOptionId: snippet ? this.optionIdFor(snippet.key) : undefined };
	}

	optionIdFor(snippetKey: string): string {
		return `${this.#idPrefix}-snippet-command-option-${encodeURIComponent(snippetKey)}`;
	}

	highlight(snippetKey: string): void {
		this.#highlight = { query: this.#options.query, key: snippetKey };
	}

	select(snippet: SelectableSnippet): void {
		if (this.contextAvailable) this.#options.onInsert(snippet);
	}

	// Enter falls through to the composer when nothing is listed, so a typed
	// `/s name` still submits while the catalog loads or misses the name. Tab
	// and arrows are always consumed so focus cannot leave the open menu.
	handleKeyDown(event: KeyboardEvent): boolean {
		if (!this.#options.visible) return false;
		const snippet = this.#highlightedSnippet;
		switch (event.key) {
			case 'Escape':
				event.preventDefault();
				this.#options.onClose();
				return true;
			case 'ArrowDown':
			case 'ArrowUp':
				event.preventDefault();
				this.#moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
				return true;
			case 'Tab':
				event.preventDefault();
				if (snippet && !event.shiftKey) this.#options.onComplete(snippet);
				return true;
			case 'Enter':
				if (!snippet) return false;
				event.preventDefault();
				this.select(snippet);
				return true;
			default:
				return false;
		}
	}

	#moveHighlight(offset: number): void {
		const count = this.#filteredSnippets.length;
		if (count === 0) return;
		const next = this.#filteredSnippets[(this.#highlightedIndex + offset + count) % count];
		if (next) this.highlight(next.key);
	}
}
