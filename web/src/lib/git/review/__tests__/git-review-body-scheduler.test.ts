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
		const scheduler = new GitReviewBodyScheduler({
			maxBatchFiles: 1,
			load: (paths, purpose) => {
				calls.push({ paths, purpose });
				return purpose === 'prefetch' ? firstPrefetch.promise : Promise.resolve('visible');
			},
			onResult: vi.fn(),
			onError: vi.fn(),
			onLoadingChange: vi.fn(),
		});

		scheduler.requestPrefetch(['a.ts', 'b.ts']);
		scheduler.requestVisible(['b.ts']);

		await vi.waitFor(() =>
			expect(calls).toContainEqual({ paths: ['b.ts'], purpose: 'visible' }),
		);
		expect(calls[0]).toEqual({ paths: ['a.ts'], purpose: 'prefetch' });
		firstPrefetch.resolve('prefetched');
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
