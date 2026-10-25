import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import { selectableSnippets, type SelectableSnippet } from '$lib/snippets/selectable-snippet.js';
import type { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';

/** Saved snippets and named preambles as one insertable list, loaded on demand. */
export class SelectableSnippetCatalog {
	readonly #snippets: SnippetsStore;
	readonly #preambles: PreamblesStore;

	#loading = $derived.by(
		() =>
			(this.#snippets.status === 'loading' && !this.#snippets.hasLoaded) ||
			(this.#preambles.status === 'loading' && !this.#preambles.hasLoaded),
	);
	#failed = $derived.by(
		() =>
			(this.#snippets.status === 'error' && !this.#snippets.hasLoaded) ||
			(this.#preambles.status === 'error' && !this.#preambles.hasLoaded),
	);
	#items = $derived.by(() =>
		this.#loading || this.#failed
			? []
			: selectableSnippets(this.#snippets.snippets, this.#preambles.preambles),
	);

	constructor(snippets: SnippetsStore, preambles: PreamblesStore) {
		this.#snippets = snippets;
		this.#preambles = preambles;
	}

	get loading(): boolean {
		return this.#loading;
	}

	get failed(): boolean {
		return this.#failed;
	}

	get items(): readonly SelectableSnippet[] {
		return this.#items;
	}

	// Load failures surface through `failed`; the rejected promises carry nothing more.
	ensureLoaded(): void {
		void Promise.all([this.#snippets.ensureLoaded(), this.#preambles.ensureLoaded()]).catch(
			() => undefined,
		);
	}

	retry(): void {
		void Promise.all([
			this.#snippets.refresh({ initial: true }),
			this.#preambles.refresh({ initial: true }),
		]).catch(() => undefined);
	}
}
