import { describe, expect, it, vi } from 'vitest';
import { GitReviewBodyScheduler } from '$lib/git/review/git-review-body-scheduler.js';
import { unownedGitReviewLoadingPaths } from '$lib/git/review/git-review-demand-trace.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('GitReviewBodyScheduler', () => {
	it('preserves loading ownership throughout cancelled prefetch promotion', async () => {
		const held = deferred<string>();
		const loading = new Set<string>();
		const unowned: string[][] = [];
		const scheduler: GitReviewBodyScheduler<string> = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			load: (_paths, purpose) => (purpose === 'prefetch' ? held.promise : Promise.resolve('ready')),
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange: (paths, isLoading) => {
				for (const path of paths) {
					if (isLoading) loading.add(path);
					else loading.delete(path);
				}
				const lost = unownedGitReviewLoadingPaths(loading, (path) => scheduler.hasPending(path));
				if (lost.length > 0) unowned.push(lost);
			},
		});
		scheduler.requestPrefetch(['neighbor', 'target']);
		scheduler.requestNavigation(['target']);
		scheduler.retainVisible(new Set());
		scheduler.cancelPrefetch();
		expect(unowned).toEqual([]);
		expect([...loading]).toEqual(['target']);
		held.resolve('late');
		await vi.waitFor(() => expect(loading.size).toBe(0));
		expect(unowned).toEqual([]);
	});

	it('publishes cancellation once, including after the aborted lane settles', async () => {
		const held = deferred<string>();
		const onLoadingChange = vi.fn();
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			load: () => held.promise,
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange,
		});
		scheduler.requestVisible(['a']);
		scheduler.retainVisible(new Set());
		scheduler.retainVisible(new Set());
		expect(onLoadingChange.mock.calls).toEqual([
			[['a'], true],
			[['a'], false],
		]);
		held.resolve('late');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(onLoadingChange.mock.calls).toEqual([
			[['a'], true],
			[['a'], false],
		]);
	});

	it.each(['visible', 'prefetch'] as const)(
		'accepts renewed demand for a published file while its %s batch is unfinished',
		async (purpose) => {
			const held = deferred<string>();
			const calls: string[][] = [];
			const onResult = vi.fn();
			const onLoadingChange = vi.fn();
			let publishBatch!: (result: string, paths: string[]) => void;
			const scheduler = new GitReviewBodyScheduler({
				maxBatchFiles: 4,
				load: (paths, _purpose, _signal, publish) => {
					calls.push(paths);
					if (calls.length === 1) {
						publishBatch = publish;
						return held.promise;
					}
					return Promise.resolve('renewed');
				},
				onResult,
				onError: vi.fn(),
				onLoadingChange,
			});
			if (purpose === 'visible') scheduler.requestVisible(['a', 'b']);
			else scheduler.requestPrefetch(['a', 'b']);
			publishBatch('original', ['a']);
			expect(scheduler.hasPending('a')).toBe(false);
			expect(scheduler.requestVisible(['a'])).toBe(true);
			held.resolve('original');
			await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(3));
			expect(calls).toEqual([['a', 'b'], ['a']]);
			expect(onResult).toHaveBeenCalledWith('renewed', ['a'], 'visible');
			expect(onLoadingChange.mock.calls.every(([paths]) => paths.length > 0)).toBe(true);
		},
	);

	it('cancels remaining batch work when only an already-published file is retained', () => {
		const held = deferred<string>();
		let publishBatch!: (result: string, paths: string[]) => void;
		let batchSignal!: AbortSignal;
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			load: (_paths, _purpose, signal, publish) => {
				batchSignal = signal;
				publishBatch = publish;
				return held.promise;
			},
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
		});
		scheduler.requestVisible(['a', 'b']);
		publishBatch('ready', ['a']);
		scheduler.retainVisible(new Set(['a']));
		expect(batchSignal.aborted).toBe(true);
		expect(scheduler.hasPending('b')).toBe(false);
		held.resolve('late');
	});

	it('keeps loading ownership when a result callback renews the same path', async () => {
		const held = deferred<string>();
		const renewed = deferred<string>();
		let publishBatch!: (result: string, paths: string[]) => void;
		const onLoadingChange = vi.fn();
		const scheduler: GitReviewBodyScheduler<string> = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			load: (_paths, purpose, _signal, publish) => {
				if (purpose === 'visible') return renewed.promise;
				publishBatch = publish;
				return held.promise;
			},
			onResult: (result) => {
				if (result === 'retry') scheduler.requestNavigation(['a']);
			},
			onError: vi.fn(),
			onLoadingChange,
		});
		scheduler.requestPrefetch(['a', 'b']);
		publishBatch('retry', ['a']);
		expect(onLoadingChange.mock.calls).toEqual([
			[['a', 'b'], true],
			[['a'], true],
		]);
		expect(scheduler.hasPending('a')).toBe(true);
		held.resolve('done');
		renewed.resolve('done');
		await vi.waitFor(() => expect(scheduler.hasPending('a')).toBe(false));
	});

	it('keeps navigation ahead of subsequent viewport demand', async () => {
		const held = deferred<string>();
		const calls: string[][] = [];
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			load: (paths) => {
				calls.push(paths);
				return calls.length === 1 ? held.promise : Promise.resolve('ready');
			},
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
		});
		scheduler.requestVisible(['old']);
		scheduler.requestNavigation(['target']);
		scheduler.requestVisible(['target', 'neighbor']);
		held.resolve('ready');
		await vi.waitFor(() => expect(scheduler.hasPending('neighbor')).toBe(false));
		expect(calls).toEqual([['old'], ['target'], ['neighbor']]);
	});

	it('retains navigation learned after the active batch lost viewport demand', async () => {
		const held = deferred<string[]>();
		const calls: string[][] = [];
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			load: (paths) => {
				calls.push(paths);
				return calls.length === 1 ? held.promise : Promise.resolve([]);
			},
			deferredPaths: (result) => result,
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
		});
		scheduler.requestVisible(['a', 'target']);
		scheduler.retainVisible(new Set(['a']));
		scheduler.requestNavigation(['target']);
		held.resolve(['target']);
		await vi.waitFor(() => expect(scheduler.hasPending('target')).toBe(false));
		expect(calls).toEqual([['a', 'target'], ['target']]);
	});

	it('promotes navigation out of a cancelled hidden prefetch batch', async () => {
		const held = deferred<string>();
		const calls: Array<{ paths: string[]; purpose: string }> = [];
		const onResult = vi.fn();
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			load: (paths, purpose) => {
				calls.push({ paths, purpose });
				return purpose === 'prefetch' ? held.promise : Promise.resolve('current');
			},
			onResult,
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
		});
		scheduler.requestPrefetch(['neighbor', 'target']);
		scheduler.requestNavigation(['target']);
		scheduler.retainVisible(new Set());
		scheduler.cancelPrefetch();
		held.resolve('late');
		await vi.waitFor(() =>
			expect(onResult).toHaveBeenCalledExactlyOnceWith('current', ['target'], 'visible'),
		);
		expect(calls).toEqual([
			{ paths: ['neighbor', 'target'], purpose: 'prefetch' },
			{ paths: ['target'], purpose: 'visible' },
		]);
	});

	it('keeps selected work while dropping obsolete visible queues and hidden speculation', async () => {
		const held = deferred<string>();
		const calls: Array<{ paths: string[]; signal: AbortSignal }> = [];
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			load: (paths, _purpose, signal) => {
				calls.push({ paths, signal });
				return held.promise;
			},
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
		});
		scheduler.requestNavigation(['selected']);
		scheduler.requestVisible(['old']);
		scheduler.requestPrefetch(['neighbor']);
		scheduler.retainVisible(new Set());
		scheduler.cancelPrefetch();
		expect(calls[0].signal.aborted).toBe(false);
		expect(calls[1].signal.aborted).toBe(true);
		expect(scheduler.hasPending('old')).toBe(false);
		held.resolve('selected');
		await vi.waitFor(() => expect(scheduler.hasPending('selected')).toBe(false));
		expect(calls.map((call) => call.paths)).toEqual([['selected'], ['neighbor']]);
	});
	it('publishes incrementally, retries only retained deferrals as singletons, and never republishes', async () => {
		type Result = { deferred: string[] };
		const batch = deferred<Result>();
		const results: string[][] = [];
		const calls: string[][] = [];
		const loading = new Set<string>();
		const unowned: string[][] = [];
		const onError = vi.fn();
		let publishBatch!: (result: Result, paths: string[]) => void;
		const scheduler: GitReviewBodyScheduler<Result> = new GitReviewBodyScheduler<Result>({
			maxBatchFiles: 4,
			load: (paths, _purpose, _signal, publish) => {
				calls.push(paths);
				if (calls.length === 1) {
					publishBatch = publish;
					return batch.promise;
				}
				return Promise.resolve({ deferred: [] });
			},
			deferredPaths: (result) => result.deferred,
			onResult: (_result, paths) => results.push(paths),
			onLoadingChange: (paths, isLoading) => {
				for (const path of paths) {
					if (isLoading) loading.add(path);
					else loading.delete(path);
				}
				const lost = unownedGitReviewLoadingPaths(loading, (path) => scheduler.hasPending(path));
				if (lost.length > 0) unowned.push(lost);
			},
			onError,
		});
		scheduler.requestVisible(['a', 'b', 'c', 'obsolete']);
		publishBatch({ deferred: [] }, ['a']);
		expect(results).toEqual([['a']]);
		scheduler.retainVisible(new Set(['a', 'b', 'c']));
		batch.resolve({ deferred: ['b', 'c', 'obsolete'] });
		await vi.waitFor(() => expect(results).toEqual([['a'], ['b'], ['c']]));
		expect(calls).toEqual([['a', 'b', 'c', 'obsolete'], ['b'], ['c']]);
		expect(onError).not.toHaveBeenCalled();
		expect(unowned).toEqual([]);
		expect(loading.size).toBe(0);
	});

	it('fences partial callbacks after cancellation and recovers demand renewed before settlement', async () => {
		const held = deferred<string>();
		const onResult = vi.fn();
		const calls: string[][] = [];
		let publishOld!: (result: string, paths: string[]) => void;
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 4,
			load: (paths, _purpose, _signal, publish) => {
				calls.push(paths);
				if (calls.length === 1) {
					publishOld = publish;
					return held.promise;
				}
				return Promise.resolve('current');
			},
			onResult,
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
		});
		scheduler.requestVisible(['a']);
		scheduler.retainVisible(new Set());
		scheduler.requestVisible(['a']);
		publishOld('late', ['a']);
		held.resolve('late');
		await vi.waitFor(() =>
			expect(onResult).toHaveBeenCalledExactlyOnceWith('current', ['a'], 'visible'),
		);
		expect(calls).toEqual([['a'], ['a']]);
	});

	it('rejects deferred singletons without looping and prioritizes queued navigation', async () => {
		const held = deferred<string[]>();
		const calls: string[][] = [];
		const onError = vi.fn();
		const scheduler = new GitReviewBodyScheduler<string[]>({
			maxBatchFiles: 4,
			load: (paths) => {
				calls.push(paths);
				return calls.length === 1 ? held.promise : Promise.resolve(paths);
			},
			deferredPaths: (result) => result,
			onResult: vi.fn(),
			onError,
			onLoadingChange: vi.fn(),
		});
		scheduler.requestVisible(['first']);
		scheduler.requestVisible(['a', 'b', 'c']);
		scheduler.requestNavigation(['c']);
		held.resolve([]);
		await vi.waitFor(() => expect(onError).toHaveBeenCalled());
		expect(calls[1]).toEqual(['c']);
		await vi.waitFor(() => expect(scheduler.hasPending('a')).toBe(false));
		expect(calls).toEqual([['first'], ['c'], ['a', 'b'], ['a'], ['b']]);
	});
	it('publishes the visible file before a delayed prefetch batch', async () => {
		const visible = deferred<string>();
		const prefetch = deferred<string>();
		const results: string[] = [];
		const calls: Array<{ paths: string[]; purpose: string }> = [];
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 24,
			load: (paths, purpose) => {
				calls.push({ paths, purpose });
				return purpose === 'visible' ? visible.promise : prefetch.promise;
			},
			onResult: (result) => results.push(result),
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
		});

		scheduler.requestVisible(['selected.ts']);
		scheduler.requestPrefetch(['a.ts', 'b.ts']);

		expect(calls).toEqual([
			{ paths: ['selected.ts'], purpose: 'visible' },
			{ paths: ['a.ts', 'b.ts'], purpose: 'prefetch' },
		]);
		visible.resolve('selected');
		await vi.waitFor(() => expect(results).toEqual(['selected']));
		expect(scheduler.hasPending('a.ts')).toBe(true);
		prefetch.resolve('neighbors');
		await vi.waitFor(() => expect(results).toEqual(['selected', 'neighbors']));
	});

	it('promotes queued prefetch paths into the visible lane', async () => {
		const firstPrefetch = deferred<string>();
		const calls: Array<{ paths: string[]; purpose: string }> = [];
		const onDispatch = vi.fn();
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 1,
			load: (paths, purpose) => {
				calls.push({ paths, purpose });
				return purpose === 'prefetch' ? firstPrefetch.promise : Promise.resolve('visible');
			},
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
			onDispatch,
		});

		expect(scheduler.requestPrefetch(['a.ts', 'b.ts'])).toBe(true);
		expect(scheduler.requestVisible(['b.ts'])).toBe(true);

		await vi.waitFor(() => expect(calls).toContainEqual({ paths: ['b.ts'], purpose: 'visible' }));
		expect(calls[0]).toEqual({ paths: ['a.ts'], purpose: 'prefetch' });
		expect(onDispatch).toHaveBeenCalledWith(['a.ts'], 'prefetch');
		expect(onDispatch).toHaveBeenCalledWith(['b.ts'], 'visible');
		firstPrefetch.resolve('prefetched');
	});

	it('does not duplicate an active prefetch when it becomes visible', () => {
		const prefetch = deferred<string>();
		const load = vi.fn(() => prefetch.promise);
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 1,
			load,
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
		});

		expect(scheduler.requestPrefetch(['a.ts'])).toBe(true);
		expect(scheduler.requestVisible(['a.ts'])).toBe(false);

		expect(load).toHaveBeenCalledOnce();
		expect(load).toHaveBeenCalledWith(
			['a.ts'],
			'prefetch',
			expect.any(AbortSignal),
			expect.any(Function),
		);
		prefetch.resolve('prefetched');
	});

	it('cancels speculative work without interrupting the visible lane', async () => {
		const visible = deferred<string>();
		const prefetch = deferred<string>();
		const loadingChanges: Array<{ paths: string[]; loading: boolean }> = [];
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 1,
			load: (_paths, purpose) => (purpose === 'visible' ? visible.promise : prefetch.promise),
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange: (paths, loading) => loadingChanges.push({ paths, loading }),
		});

		scheduler.requestVisible(['selected.ts']);
		scheduler.requestPrefetch(['a.ts', 'b.ts']);
		scheduler.cancelPrefetch();

		expect(scheduler.hasPending('selected.ts')).toBe(true);
		expect(scheduler.hasPending('b.ts')).toBe(false);
		expect(loadingChanges).toContainEqual({ paths: ['b.ts', 'a.ts'], loading: false });
		visible.resolve('visible');
		prefetch.resolve('prefetch');
	});
});
