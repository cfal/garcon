import { describe, expect, it, vi } from 'vitest';
import { GitReviewBodyScheduler } from '$lib/git/review/git-review-body-scheduler.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe('GitReviewBodyScheduler', () => {
	it('publishes incrementally, retries only retained deferrals as singletons, and never republishes', async () => {
		type Result = { deferred: string[] };
		const batch = deferred<Result>();
		const results: string[][] = [];
		const calls: string[][] = [];
		const onError = vi.fn();
		let publishBatch!: (result: Result, paths: string[]) => void;
		const scheduler = new GitReviewBodyScheduler<Result>({
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
			onLoadingChange: vi.fn(),
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
		expect(loadingChanges).toContainEqual({ paths: ['b.ts'], loading: false });
		visible.resolve('visible');
		prefetch.resolve('prefetch');
	});
});
