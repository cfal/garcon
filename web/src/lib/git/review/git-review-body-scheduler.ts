import type { GitReviewBodyPurpose } from '$lib/api/git.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';

interface GitReviewBodySchedulerOptions<T> {
	maxBatchFiles: number;
	load: (paths: string[], purpose: GitReviewBodyPurpose, signal: AbortSignal) => Promise<T>;
	onResult: (result: T, paths: string[], purpose: GitReviewBodyPurpose) => void;
	onError: (error: unknown) => void;
	onLoadingChange: (paths: string[], loading: boolean) => void;
}

interface ActiveLane {
	controller: AbortController;
	paths: string[];
}

export class GitReviewBodyScheduler<T> {
	private readonly visibleQueue: string[] = [];
	private readonly prefetchQueue: string[] = [];
	private visibleActive: ActiveLane | null = null;
	private prefetchActive: ActiveLane | null = null;
	private generation = 0;

	constructor(private readonly options: GitReviewBodySchedulerOptions<T>) {}

	requestVisible(paths: readonly string[]): void {
		const requested = this.unique(paths).filter((path) => !this.isVisiblePending(path));
		if (requested.length === 0) return;
		this.removeQueued(this.prefetchQueue, requested);
		this.enqueue(this.visibleQueue, requested, true);
		this.pump('visible');
	}

	requestPrefetch(paths: readonly string[]): void {
		const requested = this.unique(paths).filter((path) => !this.hasPending(path));
		if (requested.length === 0) return;
		this.enqueue(this.prefetchQueue, requested, false);
		this.pump('prefetch');
	}

	cancel(): void {
		this.generation += 1;
		const pending = this.allPendingPaths();
		this.visibleActive?.controller.abort();
		this.prefetchActive?.controller.abort();
		this.visibleActive = null;
		this.prefetchActive = null;
		this.visibleQueue.splice(0);
		this.prefetchQueue.splice(0);
		if (pending.length > 0) this.options.onLoadingChange(pending, false);
	}

	cancelPrefetch(): void {
		const queued = this.prefetchQueue.splice(0);
		this.prefetchActive?.controller.abort();
		if (queued.length > 0) {
			const idle = queued.filter((path) => !this.hasPending(path));
			if (idle.length > 0) this.options.onLoadingChange(idle, false);
		}
	}

	hasPending(path: string): boolean {
		return (
			this.visibleQueue.includes(path) ||
			this.prefetchQueue.includes(path) ||
			this.visibleActive?.paths.includes(path) === true ||
			this.prefetchActive?.paths.includes(path) === true
		);
	}

	private unique(paths: readonly string[]): string[] {
		return Array.from(new Set(paths.filter(Boolean)));
	}

	private isVisiblePending(path: string): boolean {
		return this.visibleQueue.includes(path) || this.visibleActive?.paths.includes(path) === true;
	}

	private enqueue(queue: string[], paths: string[], prepend: boolean): void {
		if (prepend) queue.unshift(...paths);
		else queue.push(...paths);
		this.options.onLoadingChange(paths, true);
	}

	private removeQueued(queue: string[], paths: readonly string[]): void {
		const removed = new Set(paths);
		for (let index = queue.length - 1; index >= 0; index -= 1) {
			if (removed.has(queue[index])) queue.splice(index, 1);
		}
	}

	private pump(purpose: GitReviewBodyPurpose): void {
		const active = purpose === 'visible' ? this.visibleActive : this.prefetchActive;
		const queue = purpose === 'visible' ? this.visibleQueue : this.prefetchQueue;
		if (active || queue.length === 0) return;
		const paths = queue.splice(0, this.options.maxBatchFiles);
		const controller = new AbortController();
		const lane = { controller, paths };
		if (purpose === 'visible') this.visibleActive = lane;
		else this.prefetchActive = lane;
		const generation = this.generation;

		void this.options
			.load(paths, purpose, controller.signal)
			.then((result) => {
				if (generation !== this.generation || controller.signal.aborted) return;
				this.options.onResult(result, paths, purpose);
			})
			.catch((error) => {
				if (generation !== this.generation || controller.signal.aborted || isAbortError(error)) return;
				this.options.onError(error);
			})
			.finally(() => {
				if (generation !== this.generation) return;
				if (purpose === 'visible' && this.visibleActive === lane) this.visibleActive = null;
				if (purpose === 'prefetch' && this.prefetchActive === lane) this.prefetchActive = null;
				this.pump(purpose);
				const idle = paths.filter((path) => !this.hasPending(path));
				if (idle.length > 0) this.options.onLoadingChange(idle, false);
			});
	}

	private allPendingPaths(): string[] {
		return Array.from(
			new Set([
				...this.visibleQueue,
				...this.prefetchQueue,
				...(this.visibleActive?.paths ?? []),
				...(this.prefetchActive?.paths ?? []),
			]),
		);
	}
}
