// Root-owned state of automatic pull request review: connected repositories,
// the cross-repository inbox, and recent review runs. Server invalidations
// refresh it; snapshots older than the one held are ignored.

import { untrack } from 'svelte';
import {
	abandonPullRequestReviewPost,
	connectPullRequestReviewRepository,
	getPullRequestReviews,
	postPullRequestReview,
	removePullRequestReviewRepository,
	requestPullRequestReview,
	scanPullRequestReviewRepositories,
	stopPullRequestReview,
	updatePullRequestReviewRepository,
} from '$lib/api/pull-request-reviews.js';
import { ghRepositoryIdentity } from '$shared/gh-identity';
import type {
	PullRequestReviewRepository,
	PullRequestReviewRepositoryInput,
	PullRequestReviewsSnapshot,
} from '$shared/pull-request-reviews';
import { errorMessage } from '$lib/utils/error-message.js';

export type PullRequestReviewsStatus = 'idle' | 'loading' | 'ready' | 'error';

// A requested scan that publishes no change, such as a repeated identical failure, stops showing as pending after this.
const SCAN_FEEDBACK_TIMEOUT_MS = 30_000;

export interface PullRequestReviewsApi {
	get: typeof getPullRequestReviews;
	connect: typeof connectPullRequestReviewRepository;
	update: typeof updatePullRequestReviewRepository;
	remove: typeof removePullRequestReviewRepository;
	scan: typeof scanPullRequestReviewRepositories;
	review: typeof requestPullRequestReview;
	stop: typeof stopPullRequestReview;
	post: typeof postPullRequestReview;
	abandon: typeof abandonPullRequestReviewPost;
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
	abandon: abandonPullRequestReviewPost,
};

export class PullRequestReviewsStore {
	status = $state<PullRequestReviewsStatus>('idle');
	snapshot = $state<PullRequestReviewsSnapshot | null>(null);
	error = $state<string | null>(null);
	isRefreshing = $state(false);
	// Repositories with a requested scan, keyed to their scan state when it was requested.
	scanning = $state<ReadonlyMap<string, string>>(new Map());
	#scanTimer: ReturnType<typeof setTimeout> | null = null;
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

	get isScanning(): boolean {
		return this.scanning.size > 0;
	}

	isScanningRepository(id: string): boolean {
		return this.scanning.has(id);
	}

	repository(id: string): PullRequestReviewRepository | null {
		return this.repositories.find((repository) => repository.id === id) ?? null;
	}

	repositoryLabel(id: string): string {
		const repository = this.repository(id);
		if (!repository) return '';
		const host = ghRepositoryIdentity(repository)?.host;
		const collision = this.repositories.some(
			(other) =>
				other.id !== id &&
				other.nameWithOwner.toLowerCase() === repository.nameWithOwner.toLowerCase() &&
				ghRepositoryIdentity(other)?.host !== host,
		);
		return collision && host ? `${repository.nameWithOwner} (${host})` : repository.nameWithOwner;
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
		this.#settleScans();
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

	// The server scans in the background; a repository stays pending until its scan state changes.
	async scan(repositoryId?: string): Promise<void> {
		const requested = repositoryId
			? this.repositories.filter((repository) => repository.id === repositoryId)
			: this.repositories;
		const scanning = new Map(this.scanning);
		for (const repository of requested)
			scanning.set(repository.id, JSON.stringify(repository.scan));
		this.scanning = scanning;
		if (this.#scanTimer) clearTimeout(this.#scanTimer);
		this.#scanTimer = setTimeout(() => this.#clearScans(), SCAN_FEEDBACK_TIMEOUT_MS);
		try {
			await this.api.scan(repositoryId);
		} catch (error) {
			this.#clearScans();
			throw error;
		}
	}

	#settleScans(): void {
		if (this.scanning.size === 0) return;
		const pending = new Map(
			[...this.scanning].filter(([id, scan]) => {
				const repository = this.repository(id);
				return repository !== null && JSON.stringify(repository.scan) === scan;
			}),
		);
		if (pending.size === this.scanning.size) return;
		if (pending.size === 0) this.#clearScans();
		else this.scanning = pending;
	}

	#clearScans(): void {
		if (this.#scanTimer) clearTimeout(this.#scanTimer);
		this.#scanTimer = null;
		this.scanning = new Map();
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

	async abandon(runId: string): Promise<void> {
		this.apply(await this.api.abandon(runId));
	}
}
