import type { GitReviewBodyPurpose } from '$lib/api/git.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';

interface GitReviewBodySchedulerOptions<T> {
	maxBatchFiles: number;
	load: (
		paths: string[],
		purpose: GitReviewBodyPurpose,
		signal: AbortSignal,
		publish: (result: T, paths: string[]) => void,
	) => Promise<T>;
	deferredPaths?: (result: T) => readonly string[];
	onResult: (result: T, paths: string[], purpose: GitReviewBodyPurpose) => void;
	onError: (error: unknown) => void;
	onLoadingChange: (paths: string[], loading: boolean) => void;
	onDispatch?: (paths: string[], purpose: GitReviewBodyPurpose) => void;
}

interface ActiveLane {
	controller: AbortController;
	paths: string[];
	retained: Set<string>;
	published: Set<string>;
}

function laneOwnsPath(lane: ActiveLane | null, path: string): boolean {
	return (
		lane !== null &&
		!lane.controller.signal.aborted &&
		!lane.published.has(path) &&
		lane.paths.includes(path)
	);
}

export class GitReviewBodyScheduler<T> {
	private readonly visibleQueue: string[] = [];
	private readonly prefetchQueue: string[] = [];
	private visibleActive: ActiveLane | null = null;
	private prefetchActive: ActiveLane | null = null;
	private generation = 0;
	private readonly singletonPaths = new Set<string>();
	private readonly navigationPaths = new Set<string>();
	private visiblePaths = new Set<string>();

	constructor(private readonly options: GitReviewBodySchedulerOptions<T>) {}

	requestNavigation(paths: readonly string[]): boolean {
		const unique = this.unique(paths);
		this.navigationPaths.clear();
		for (const path of unique) {
			this.navigationPaths.add(path);
			this.singletonPaths.add(path);
		}
		this.removeQueued(this.visibleQueue, unique);
		return this.queueVisible(unique);
	}

	requestVisible(paths: readonly string[]): boolean {
		const uniquePaths = this.unique(paths);
		for (const path of uniquePaths) this.visiblePaths.add(path);
		return this.queueVisible(uniquePaths);
	}

	private queueVisible(uniquePaths: string[]): boolean {
		this.removeQueued(this.prefetchQueue, uniquePaths);
		const requested = uniquePaths.filter((path) => !this.hasPending(path));
		if (requested.length === 0) return false;
		this.visibleQueue.unshift(...requested);
		this.options.onLoadingChange(requested, true);
		this.pump('visible');
		return true;
	}

	requestPrefetch(paths: readonly string[]): boolean {
		const requested = this.unique(paths).filter((path) => !this.hasPending(path));
		if (requested.length === 0) return false;
		this.prefetchQueue.push(...requested);
		this.options.onLoadingChange(requested, true);
		this.pump('prefetch');
		return true;
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
		this.singletonPaths.clear();
		this.navigationPaths.clear();
		this.visiblePaths.clear();
		if (pending.length > 0) this.options.onLoadingChange(pending, false);
	}

	cancelPrefetch(): void {
		const queued = this.prefetchQueue.splice(0);
		const active = this.prefetchActive;
		if (active && !active.controller.signal.aborted) {
			queued.push(...active.paths);
			active.controller.abort();
		}
		const promoted = this.unique(queued).filter(
			(path) =>
				!active?.published.has(path) &&
				(this.visiblePaths.has(path) || this.navigationPaths.has(path)) &&
				!this.hasPending(path),
		);
		// Promoted paths retain loading ownership while their abandoned siblings are released.
		this.visibleQueue.unshift(...promoted);
		const idle = queued.filter((path) => !this.hasPending(path));
		if (idle.length > 0) this.options.onLoadingChange(idle, false);
		this.pump('visible');
	}

	retainVisible(paths: ReadonlySet<string>): void {
		this.visiblePaths = new Set(paths);
		const retained = new Set(paths);
		for (const path of this.navigationPaths) retained.add(path);
		const removed = this.visibleQueue.filter((path) => !retained.has(path));
		this.removeQueued(this.visibleQueue, removed);
		const active = this.visibleActive;
		if (active) active.retained = retained;
		if (
			active &&
			!active.controller.signal.aborted &&
			!active.paths.some((path) => !active.published.has(path) && retained.has(path))
		) {
			active.controller.abort();
			removed.push(...active.paths);
		}
		const idle = this.unique(removed).filter((path) => !this.hasPending(path));
		if (idle.length > 0) this.options.onLoadingChange(idle, false);
	}

	hasPending(path: string): boolean {
		return (
			this.visibleQueue.includes(path) ||
			this.prefetchQueue.includes(path) ||
			laneOwnsPath(this.visibleActive, path) ||
			laneOwnsPath(this.prefetchActive, path)
		);
	}

	private unique(paths: readonly string[]): string[] {
		return Array.from(new Set(paths.filter(Boolean)));
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
		if (purpose === 'visible') {
			const navigationIndex = queue.findIndex((path) => this.navigationPaths.has(path));
			if (navigationIndex > 0) queue.unshift(...queue.splice(navigationIndex, 1));
		}
		let count = 1;
		if (!this.singletonPaths.has(queue[0])) {
			while (
				count < Math.min(queue.length, this.options.maxBatchFiles) &&
				!this.singletonPaths.has(queue[count])
			)
				count++;
		}
		const paths = queue.splice(0, count);
		for (const path of paths) this.singletonPaths.delete(path);
		const controller = new AbortController();
		const published = new Set<string>();
		const lane = { controller, paths, retained: new Set(paths), published };
		if (purpose === 'visible') this.visibleActive = lane;
		else this.prefetchActive = lane;
		const generation = this.generation;
		let deferred: string[] = [];
		const publishPaths = (result: T, completed: string[], resultPurpose: GitReviewBodyPurpose) => {
			if (generation !== this.generation || controller.signal.aborted) return;
			const fresh = completed.filter((path) => paths.includes(path) && !published.has(path));
			if (fresh.length === 0) return;
			for (const path of fresh) {
				published.add(path);
				this.navigationPaths.delete(path);
			}
			this.options.onResult(result, fresh, resultPurpose);
			if (generation === this.generation && !controller.signal.aborted) {
				const idle = fresh.filter((path) => !this.hasPending(path));
				if (idle.length > 0) this.options.onLoadingChange(idle, false);
			}
		};
		const publish = (result: T, completed: string[]) => {
			if (purpose === 'visible') {
				publishPaths(result, completed, purpose);
				return;
			}
			const navigation = completed.filter((path) => this.navigationPaths.has(path));
			const speculative = completed.filter((path) => !this.navigationPaths.has(path));
			publishPaths(result, navigation, 'visible');
			publishPaths(result, speculative, 'prefetch');
		};
		this.options.onDispatch?.(paths, purpose);

		void this.options
			.load(paths, purpose, controller.signal, publish)
			.then((result) => {
				if (generation !== this.generation || controller.signal.aborted) return;
				deferred = [...(this.options.deferredPaths?.(result) ?? [])];
				if (
					deferred.some((path) => !paths.includes(path) || published.has(path)) ||
					(paths.length === 1 && deferred.length > 0)
				) {
					deferred = [];
					throw new Error('Invalid deferred Git body response.');
				}
				publish(
					result,
					paths.filter((path) => !deferred.includes(path)),
				);
			})
			.catch((error) => {
				if (generation !== this.generation || controller.signal.aborted || isAbortError(error))
					return;
				this.options.onError(error);
			})
			.finally(() => {
				if (generation !== this.generation) return;
				if (purpose === 'visible' && this.visibleActive === lane) this.visibleActive = null;
				if (purpose === 'prefetch' && this.prefetchActive === lane) this.prefetchActive = null;
				if (!controller.signal.aborted) {
					const retry = deferred.filter(
						(path) =>
							(lane.retained.has(path) || this.navigationPaths.has(path)) && !this.hasPending(path),
					);
					for (const path of retry) this.singletonPaths.add(path);
					if (purpose === 'prefetch') {
						const visible: string[] = [];
						const speculative: string[] = [];
						for (const path of retry) {
							if (this.navigationPaths.has(path) || this.visiblePaths.has(path)) visible.push(path);
							else speculative.push(path);
						}
						this.visibleQueue.unshift(...visible);
						queue.unshift(...speculative);
						if (visible.length > 0) this.pump('visible');
					} else {
						queue.unshift(...retry);
					}
				}
				this.pump(purpose);
				if (!controller.signal.aborted) {
					const idle = paths.filter((path) => !this.hasPending(path));
					for (const path of idle) this.navigationPaths.delete(path);
					if (idle.length > 0) this.options.onLoadingChange(idle, false);
				}
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
