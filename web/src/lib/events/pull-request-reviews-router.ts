import type { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import { parseServerWsMessage } from '$shared/ws-events';
import { PullRequestReviewsInvalidatedMessage } from '$shared/ws-revision-invalidations';

export class PullRequestReviewsRouter {
	#handle: DrainHandle | null = null;

	constructor(
		private readonly ws: WsMessageLog,
		private readonly reviews: Pick<PullRequestReviewsStore, 'invalidate'>,
	) {}

	start(): void {
		if (!this.#handle) this.#handle = createDrainCursor(this.ws);
	}

	tick(): void {
		for (const message of this.#handle?.drain() ?? []) {
			if (message.data.type !== 'pull-request-reviews-invalidated') continue;
			const parsed = parseServerWsMessage(message.data);
			if (parsed instanceof PullRequestReviewsInvalidatedMessage) this.reviews.invalidate(parsed.revision);
		}
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
	}
}
