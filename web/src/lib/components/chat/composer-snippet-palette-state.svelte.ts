import { flushSync, tick } from 'svelte';
import type {
	SnippetInsertionHandler,
	SnippetInsertionResult,
} from '$lib/chat/composer/snippet-insertion.js';
import { snippetTemplateUsesArguments, type Snippet } from '$shared/snippets';

interface ComposerSnippetPaletteStateOptions {
	get snippets(): readonly Snippet[];
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
	highlightedSnippetId = $state<string | null>(null);
	argumentsSnippet = $state<Snippet | null>(null);
	argumentsDraft = $state('');
	argumentsDraftIsFreshDefault = $state(false);
	argumentsDialogOpen = $state(false);

	#filteredSnippets = $derived.by(() => {
		const normalized = this.query.trim().toLowerCase();
		if (!normalized) return [...this.#options.snippets];
		const exact: Snippet[] = [];
		const prefix: Snippet[] = [];
		const contains: Snippet[] = [];
		const templateMatches: Snippet[] = [];
		for (const snippet of this.#options.snippets) {
			const name = snippet.shortName.toLowerCase();
			if (name === normalized) exact.push(snippet);
			else if (name.startsWith(normalized)) prefix.push(snippet);
			else if (name.includes(normalized)) contains.push(snippet);
			else if (snippet.template.toLowerCase().includes(normalized)) {
				templateMatches.push(snippet);
			}
		}
		return [...exact, ...prefix, ...contains, ...templateMatches];
	});

	#highlightedIndex = $derived.by(() => {
		const selectedIndex = this.#filteredSnippets.findIndex(
			(snippet) => snippet.id === this.highlightedSnippetId,
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

	get filteredSnippets(): readonly Snippet[] {
		return this.#filteredSnippets;
	}

	get highlightedSnippet(): Snippet | null {
		return this.#highlightedSnippet;
	}

	get contextAvailable(): boolean {
		return this.#options.contextAvailable;
	}

	syncOpen(open: boolean, initialQuery: string): void {
		if (open && !this.#wasOpen) {
			this.query = initialQuery;
			this.highlightedSnippetId = null;
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
		this.argumentsSnippet = null;
		this.argumentsDraft = '';
		this.argumentsDraftIsFreshDefault = false;
		if (open) this.#options.onOpenChange(false);
	}

	resetHighlight(): void {
		this.highlightedSnippetId = null;
	}

	highlight(snippetId: string): void {
		this.highlightedSnippetId = snippetId;
	}

	optionIdFor(snippetId: string): string {
		return `${this.#uid}-option-${encodeURIComponent(snippetId)}`;
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

	selectSnippet(snippet: Snippet): void {
		if (!this.contextAvailable) return;
		this.#suppressCancelOnClose = true;
		flushSync(() => this.#options.onOpenChange(false));
		if (snippetTemplateUsesArguments(snippet.template)) {
			queueMicrotask(() => {
				this.argumentsSnippet = snippet;
				this.argumentsDraft = snippet.defaultArguments;
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

	submitArguments(snippet: Snippet, argumentsText: string): void {
		void this.#settleInsertion(snippet, argumentsText);
	}

	settleArgumentsCancel(): void {
		this.argumentsDialogOpen = false;
		this.argumentsSnippet = null;
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
		this.highlightedSnippetId = snippet.id;
		const optionId = this.optionIdFor(snippet.id);
		void tick().then(() => {
			document.getElementById(optionId)?.scrollIntoView({ block: 'nearest' });
		});
	}

	async #settleInsertion(snippet: Snippet, argumentsText: string): Promise<void> {
		const interactionAtInsert = this.#options.interactionKey;
		const result: SnippetInsertionResult = await this.#options.onInsert(snippet, argumentsText);
		if (this.#options.interactionKey !== interactionAtInsert) return;
		if (result === 'failed' && snippetTemplateUsesArguments(snippet.template)) {
			this.argumentsSnippet = snippet;
			this.argumentsDraft = argumentsText;
			this.argumentsDraftIsFreshDefault = false;
			this.argumentsDialogOpen = true;
			return;
		}
		this.argumentsSnippet = null;
		this.argumentsDraft = '';
		this.argumentsDraftIsFreshDefault = false;
	}
}
