import { expandSnippet } from '$lib/api/snippets.js';
import type { ExpandSnippetRequest, ExpandSnippetResponse } from '$shared/snippets';

export type SnippetExpansionResult =
	| { kind: 'expanded'; response: ExpandSnippetResponse; generation: number }
	| { kind: 'cancelled' };

export interface SnippetExpansionControllerDeps {
	expand?: typeof expandSnippet;
}

export class SnippetExpansionController {
	pending = $state(false);
	pendingShortName = $state<string | null>(null);
	#generation = 0;
	#abortController: AbortController | null = null;

	constructor(private readonly deps: SnippetExpansionControllerDeps = {}) {}

	async run(request: ExpandSnippetRequest): Promise<SnippetExpansionResult> {
		if (this.pending) return { kind: 'cancelled' };
		const generation = ++this.#generation;
		const controller = new AbortController();
		this.#abortController = controller;
		this.pending = true;
		this.pendingShortName = request.shortName;
		try {
			const expand = this.deps.expand ?? expandSnippet;
			const response = await expand(request, { signal: controller.signal });
			if (controller.signal.aborted || generation !== this.#generation) {
				return { kind: 'cancelled' };
			}
			return { kind: 'expanded', response, generation };
		} catch (error) {
			if (controller.signal.aborted || generation !== this.#generation) {
				return { kind: 'cancelled' };
			}
			throw error;
		} finally {
			if (generation === this.#generation) {
				this.pending = false;
				this.pendingShortName = null;
				this.#abortController = null;
			}
		}
	}

	cancel(): void {
		this.#generation += 1;
		this.#abortController?.abort();
		this.#abortController = null;
		this.pending = false;
		this.pendingShortName = null;
	}
}
