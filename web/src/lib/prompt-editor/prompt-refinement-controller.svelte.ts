import { refinePrompt } from '$lib/api/prompt-refinement.js';
import type { RefinePromptResponse } from '$shared/prompt-refinement';

export type PromptRefinementResult =
	{ kind: 'refined'; response: RefinePromptResponse; generation: number } | { kind: 'cancelled' };

export interface PromptRefinementControllerDependencies {
	refine?: typeof refinePrompt;
}

export class PromptRefinementController {
	pending = $state(false);
	#generation = 0;
	#abortController: AbortController | null = null;

	constructor(private readonly dependencies: PromptRefinementControllerDependencies = {}) {}

	async run(draft: string): Promise<PromptRefinementResult> {
		if (this.pending) return { kind: 'cancelled' };
		const generation = ++this.#generation;
		const abortController = new AbortController();
		this.#abortController = abortController;
		this.pending = true;

		try {
			const refine = this.dependencies.refine ?? refinePrompt;
			const response = await refine({ draft }, { signal: abortController.signal });
			if (abortController.signal.aborted || generation !== this.#generation) {
				return { kind: 'cancelled' };
			}
			return { kind: 'refined', response, generation };
		} catch (error) {
			if (abortController.signal.aborted || generation !== this.#generation) {
				return { kind: 'cancelled' };
			}
			throw error;
		} finally {
			if (generation === this.#generation) {
				this.pending = false;
				this.#abortController = null;
			}
		}
	}

	cancel(): void {
		this.#generation += 1;
		this.#abortController?.abort();
		this.#abortController = null;
		this.pending = false;
	}
}
