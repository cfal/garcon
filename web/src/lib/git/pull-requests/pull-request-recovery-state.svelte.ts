import { getPullRequestReviewRecovery } from '$lib/api/pull-request-reviews.js';
import type { PullRequestReviewRun } from '$shared/pull-request-reviews';
import { errorMessage } from '$lib/utils/error-message.js';

// Owns one bounded page sequence while the unresolved-post list is open.
export class PullRequestRecoveryState {
	runs = $state<PullRequestReviewRun[]>([]);
	nextCursor = $state<string | null>(null);
	isLoading = $state(false);
	error = $state<string | null>(null);
	#controller: AbortController | null = null;

	constructor(private readonly getRecovery = getPullRequestReviewRecovery) {}

	async load(cursor?: string): Promise<void> {
		this.#controller?.abort();
		const controller = new AbortController();
		this.#controller = controller;
		this.isLoading = true;
		this.error = null;
		try {
			const page = await this.getRecovery({ cursor, signal: controller.signal });
			if (controller.signal.aborted) return;
			this.runs = cursor ? [...this.runs, ...page.runs] : page.runs;
			this.nextCursor = page.nextCursor;
		} catch (error) {
			if (!controller.signal.aborted)
				this.error = errorMessage(error, 'Unresolved posts could not be loaded.');
		} finally {
			if (this.#controller === controller) {
				this.#controller = null;
				this.isLoading = false;
			}
		}
	}

	dispose(): void {
		this.#controller?.abort();
		this.#controller = null;
	}
}
