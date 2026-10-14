// Root-owned state of automatic pull request review: connected repositories,
// the cross-repository inbox, and recent review runs. Server invalidations
// refresh it; snapshots older than the one held are ignored.

import { untrack } from 'svelte';
import {
	connectPullRequestReviewRepository,
	getPullRequestReviews,
	postPullRequestReview,
	removePullRequestReviewRepository,
	requestPullRequestReview,
	scanPullRequestReviewRepositories,
	stopPullRequestReview,
	updatePullRequestReviewRepository,
} from '$lib/api/pull-request-reviews.js';
import type {
	PullRequestReviewRepository,
	PullRequestReviewRepositoryInput,
	PullRequestReviewsSnapshot,
} from '$shared/pull-request-reviews';
import { errorMessage } from '$lib/utils/error-message.js';

export type PullRequestReviewsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PullRequestReviewsApi {
	get: typeof getPullRequestReviews;
	connect: typeof connectPullRequestReviewRepository;
	update: typeof updatePullRequestReviewRepository;
	remove: typeof removePullRequestReviewRepository;
	scan: typeof scanPullRequestReviewRepositories;
	review: typeof requestPullRequestReview;
	stop: typeof stopPullRequestReview;
	post: typeof postPullRequestReview;
}

const DEFAULT_API: PullRequestReviewsApi = {
	get: getPullRequestReviews,
	connect: connectPullRequestReviewRepository,
	update: updatePullRequestReviewRepository,
	remove: removePullRequestReviewRepository,
	scan: scanPullRequestReviewRepositories,
	review: requestPullRequestReview,
	stop: stopPullRequestReview,
	post: postPullRequestReview,
};

export class PullRequestReviewsStore {
	status = $state<PullRequestReviewsStatus>('idle');
	snapshot = $state<PullRequestReviewsSnapshot | null>(null);
	error = $state<string | null>(null);
	isRefreshing = $state(false);
	#refreshing: Promise<void> | null = null;
	#refreshAgain = false;

	constructor(private readonly api: PullRequestReviewsApi = DEFAULT_API) {}

	get repositories(): PullRequestReviewRepository[] {
		return this.snapshot?.repositories ?? [];
	}

	get inbox() {
		return this.snapshot?.inbox ?? [];
	}

	get recentRuns() {
		return this.snapshot?.recentRuns ?? [];
	}

	repository(id: string): PullRequestReviewRepository | null {
		return this.repositories.find((repository) => repository.id === id) ?? null;
	}

	async ensureLoaded(): Promise<void> {
		if (this.snapshot || this.#refreshing) return this.#refreshing ?? undefined;
		return this.refresh();
	}

	// Coalesces overlapping requests into one more read after the current one.
	refresh(): Promise<void> {
		if (this.#refreshing) {
			this.#refreshAgain = true;
			return this.#refreshing;
		}
		this.#refreshing = untrack(async () => {
			do {
				this.#refreshAgain = false;
				if (this.snapshot) this.isRefreshing = true;
				else this.status = 'loading';
				try {
					this.apply(await this.api.get());
					this.error = null;
				} catch (error) {
					this.error = errorMessage(error, 'Pull request reviews could not be loaded.');
					if (!this.snapshot) this.status = 'error';
				}
			} while (this.#refreshAgain);
		}).finally(() => {
			this.isRefreshing = false;
			this.#refreshing = null;
		});
		return this.#refreshing;
	}

	// Refreshes after a server change this store has not seen; an unloaded store stays unloaded.
	invalidate(revision?: number): void {
		if (this.status === 'idle') return;
		if (revision !== undefined && this.snapshot && revision <= this.snapshot.revision) return;
		void this.refresh();
	}

	apply(snapshot: PullRequestReviewsSnapshot): void {
		if (this.snapshot && snapshot.revision < this.snapshot.revision) return;
		this.snapshot = snapshot;
		this.status = 'ready';
	}

	async connect(input: PullRequestReviewRepositoryInput): Promise<void> {
		this.apply(await this.api.connect(input));
	}

	async update(id: string, input: PullRequestReviewRepositoryInput): Promise<void> {
		this.apply(await this.api.update(id, input));
	}

	async remove(id: string): Promise<void> {
		this.apply(await this.api.remove(id));
	}

	async scan(repositoryId?: string): Promise<void> {
		await this.api.scan(repositoryId);
	}

	async review(repositoryId: string, number: number): Promise<void> {
		this.apply(await this.api.review(repositoryId, number));
	}

	async stop(runId: string): Promise<void> {
		this.apply(await this.api.stop(runId));
	}

	async post(runId: string): Promise<void> {
		this.apply(await this.api.post(runId));
	}
}
