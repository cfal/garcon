import { expandSnippet } from '$lib/api/snippets.js';
import type { ExpandSnippetRequest, ExpandSnippetResponse } from '$shared/snippets';

export type SnippetExpansionResult =
	| { kind: 'expanded'; response: ExpandSnippetResponse; generation: number }
	| { kind: 'cancelled' };

export type PreparedSnippetExpansionResult<T> =
	| {
			kind: 'expanded';
			response: ExpandSnippetResponse;
			generation: number;
			prepared: T;
	  }
	| { kind: 'cancelled' };

export interface SnippetExpansionControllerDeps {
	expand?: typeof expandSnippet;
}

type PreparedSnippetExpansion<T> = {
	request: ExpandSnippetRequest;
	prepared: T;
};

type PrepareSnippetExpansion<T> = (
	signal: AbortSignal,
) => PreparedSnippetExpansion<T> | Promise<PreparedSnippetExpansion<T>>;

export class SnippetExpansionController {
	pending = $state(false);
	pendingShortName = $state<string | null>(null);
	#generation = 0;
	#abortController: AbortController | null = null;

	constructor(private readonly deps: SnippetExpansionControllerDeps = {}) {}

	async run(request: ExpandSnippetRequest): Promise<SnippetExpansionResult> {
		const result = await this.#run(request.shortName, () => ({
			request,
			prepared: undefined,
		}));
		return result.kind === 'cancelled'
			? result
			: {
					kind: 'expanded',
					response: result.response,
					generation: result.generation,
				};
	}

	runPrepared<T>(
		shortName: string,
		prepare: PrepareSnippetExpansion<T>,
	): Promise<PreparedSnippetExpansionResult<T>> {
		return this.#run(shortName, prepare);
	}

	async #run<T>(
		shortName: string,
		prepare: PrepareSnippetExpansion<T>,
	): Promise<PreparedSnippetExpansionResult<T>> {
		if (this.pending) return { kind: 'cancelled' };
		const generation = ++this.#generation;
		const controller = new AbortController();
		this.#abortController = controller;
		this.pending = true;
		this.pendingShortName = shortName;
		try {
			const prepared = prepare(controller.signal);
			const preparation = prepared instanceof Promise ? await prepared : prepared;
			if (controller.signal.aborted || generation !== this.#generation) {
				return { kind: 'cancelled' };
			}
			const expand = this.deps.expand ?? expandSnippet;
			const response = await expand(preparation.request, { signal: controller.signal });
			if (controller.signal.aborted || generation !== this.#generation) {
				return { kind: 'cancelled' };
			}
			return { kind: 'expanded', response, generation, prepared: preparation.prepared };
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
