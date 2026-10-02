import { flushSync, tick } from 'svelte';
import type {
	SnippetInsertionHandler,
	SnippetInsertionResult,
} from '$lib/chat/composer/snippet-insertion.js';
import type { SelectableSnippet } from '$lib/snippets/selectable-snippet.js';
import { snippetTemplateUsesArguments, type Snippet } from '$shared/snippets';

interface ComposerSnippetPaletteStateOptions {
	get snippets(): readonly SelectableSnippet[];
	get interactionKey(): string;
	get contextAvailable(): boolean;
	onOpenChange(open: boolean): void;
	onInsert: SnippetInsertionHandler;
	onCancelled?: () => void;
	onReturnFocus(): void;
	onEditSnippets(): void;
}

export class ComposerSnippetPaletteState {
	readonly #options: ComposerSnippetPaletteStateOptions;
	readonly #uid: string;
	#wasOpen = false;
	#previousInteractionKey: string | null = null;
	#suppressCancelOnClose = false;

	query = $state('');
	highlightedSnippetKey = $state<string | null>(null);
	argumentsItem = $state<SelectableSnippet | null>(null);
	argumentsDraft = $state('');
	argumentsDraftIsFreshDefault = $state(false);
	argumentsDialogOpen = $state(false);

	#filteredSnippets = $derived.by(() => {
		const normalized = this.query.trim().toLowerCase();
		if (!normalized) return [...this.#options.snippets];
		const exact: SelectableSnippet[] = [];
		const prefix: SelectableSnippet[] = [];
		const contains: SelectableSnippet[] = [];
		const templateMatches: SelectableSnippet[] = [];
		for (const snippet of this.#options.snippets) {
			const name = snippet.shortName.toLowerCase();
			if (name === normalized) exact.push(snippet);
			else if (name.startsWith(normalized)) prefix.push(snippet);
			else if (name.includes(normalized)) contains.push(snippet);
			else if (snippet.body.toLowerCase().includes(normalized)) {
				templateMatches.push(snippet);
			}
		}
		return [...exact, ...prefix, ...contains, ...templateMatches];
	});

	#highlightedIndex = $derived.by(() => {
		const selectedIndex = this.#filteredSnippets.findIndex(
			(snippet) => snippet.key === this.highlightedSnippetKey,
		);
		return selectedIndex >= 0 ? selectedIndex : this.#filteredSnippets.length > 0 ? 0 : -1;
	});

	#highlightedSnippet = $derived(
		this.#highlightedIndex >= 0 ? (this.#filteredSnippets[this.#highlightedIndex] ?? null) : null,
	);

	constructor(uid: string, options: ComposerSnippetPaletteStateOptions) {
		this.#uid = uid;
		this.#options = options;
	}

	get filteredSnippets(): readonly SelectableSnippet[] {
		return this.#filteredSnippets;
	}

	get highlightedSnippet(): SelectableSnippet | null {
		return this.#highlightedSnippet;
	}

	get argumentsSnippet(): Snippet | null {
		return this.argumentsItem?.source === 'snippet' ? this.argumentsItem.snippet : null;
	}

	get contextAvailable(): boolean {
		return this.#options.contextAvailable;
	}

	syncOpen(open: boolean, initialQuery: string): void {
		if (open && !this.#wasOpen) {
			this.query = initialQuery;
			this.highlightedSnippetKey = null;
			this.#suppressCancelOnClose = false;
		} else if (!open && this.#wasOpen) {
			this.query = '';
		}
		this.#wasOpen = open;
	}

	syncInteractionKey(interactionKey: string, open: boolean): void {
		if (this.#previousInteractionKey === null) {
			this.#previousInteractionKey = interactionKey;
			return;
		}
		if (interactionKey === this.#previousInteractionKey) return;
		this.#previousInteractionKey = interactionKey;
		this.argumentsDialogOpen = false;
		this.argumentsItem = null;
		this.argumentsDraft = '';
		this.argumentsDraftIsFreshDefault = false;
		if (open) this.#options.onOpenChange(false);
	}

	resetHighlight(): void {
		this.highlightedSnippetKey = null;
	}

	highlight(snippetKey: string): void {
		this.highlightedSnippetKey = snippetKey;
	}

	optionIdFor(snippetKey: string): string {
		return `${this.#uid}-option-${encodeURIComponent(snippetKey)}`;
	}

	handleSearchKeyDown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			this.#moveHighlight(this.#highlightedIndex + 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			this.#moveHighlight(this.#highlightedIndex - 1);
		} else if (event.key === 'Home') {
			event.preventDefault();
			this.#moveHighlight(0);
		} else if (event.key === 'End') {
			event.preventDefault();
			this.#moveHighlight(this.#filteredSnippets.length - 1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (this.#highlightedSnippet) this.selectSnippet(this.#highlightedSnippet);
		}
	}

	selectSnippet(snippet: SelectableSnippet): void {
		if (!this.contextAvailable) return;
		this.#suppressCancelOnClose = true;
		flushSync(() => this.#options.onOpenChange(false));
		if (snippet.source === 'snippet' && snippetTemplateUsesArguments(snippet.snippet.template)) {
			queueMicrotask(() => {
				this.argumentsItem = snippet;
				this.argumentsDraft = snippet.snippet.defaultArguments;
				this.argumentsDraftIsFreshDefault = true;
				this.argumentsDialogOpen = true;
			});
			return;
		}
		queueMicrotask(() => void this.#settleInsertion(snippet, ''));
	}

	closeArguments(): void {
		this.argumentsDialogOpen = false;
	}

	submitArguments(_snippet: Snippet, argumentsText: string): void {
		if (this.argumentsItem) void this.#settleInsertion(this.argumentsItem, argumentsText);
	}

	settleArgumentsCancel(): void {
		this.argumentsDialogOpen = false;
		this.argumentsItem = null;
		this.argumentsDraft = '';
		this.argumentsDraftIsFreshDefault = false;
		this.#options.onCancelled?.();
	}

	handlePaletteCloseAutoFocus(event: Event): void {
		event.preventDefault();
		this.#options.onReturnFocus();
		if (this.#suppressCancelOnClose) {
			this.#suppressCancelOnClose = false;
			return;
		}
		queueMicrotask(() => this.#options.onCancelled?.());
	}

	editSnippets(): void {
		this.#suppressCancelOnClose = true;
		this.#options.onOpenChange(false);
		queueMicrotask(this.#options.onEditSnippets);
	}

	#moveHighlight(nextIndex: number): void {
		if (this.#filteredSnippets.length === 0) return;
		const bounded = Math.max(0, Math.min(nextIndex, this.#filteredSnippets.length - 1));
		const snippet = this.#filteredSnippets[bounded];
		if (!snippet) return;
		this.highlightedSnippetKey = snippet.key;
		const optionId = this.optionIdFor(snippet.key);
		void tick().then(() => {
			document.getElementById(optionId)?.scrollIntoView({ block: 'nearest' });
		});
	}

	async #settleInsertion(snippet: SelectableSnippet, argumentsText: string): Promise<void> {
		const interactionAtInsert = this.#options.interactionKey;
		const result: SnippetInsertionResult = await this.#options.onInsert(snippet, argumentsText);
		if (this.#options.interactionKey !== interactionAtInsert) return;
		if (
			result === 'failed' &&
			snippet.source === 'snippet' &&
			snippetTemplateUsesArguments(snippet.snippet.template)
		) {
			this.argumentsItem = snippet;
			this.argumentsDraft = argumentsText;
			this.argumentsDraftIsFreshDefault = false;
			this.argumentsDialogOpen = true;
			return;
		}
		this.argumentsItem = null;
		this.argumentsDraft = '';
		this.argumentsDraftIsFreshDefault = false;
	}
}
