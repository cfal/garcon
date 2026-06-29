import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GitQuickSummaryStore,
	QUICK_GIT_PROCESSING_POLL_MS,
	QUICK_GIT_STOPPED_DEBOUNCE_MS,
} from '../git-quick-summary.svelte';
import type { GitQuickSummaryReady, GitQuickSummaryResponse } from '$lib/api/git.js';
import type { ApiFetchOptions } from '$lib/api/client.js';

function readySummary(overrides: Partial<GitQuickSummaryReady> = {}): GitQuickSummaryReady {
	return {
		status: 'ready',
		project: '/project',
		repoRoot: '/project',
		branch: 'main',
		hasCommits: true,
		changedFiles: 1,
		trackedChangedFiles: 1,
		untrackedFiles: 0,
		stagedFiles: 0,
		unstagedFiles: 1,
		additions: 2,
		deletions: 1,
		fingerprintVersion: 1,
		fingerprint: 'v1:ready',
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type GetSummary = (
	project: string,
	options?: ApiFetchOptions,
) => Promise<GitQuickSummaryResponse>;

describe('GitQuickSummaryStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('shows a pending tray until a ready response arrives for the current project', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });

		store.setProject('/project');

		expect(store.canShowTray).toBe(true);
		expect(store.summary).toBeNull();
		await vi.advanceTimersByTimeAsync(100);

		expect(getSummary).toHaveBeenCalledWith('/project', expect.objectContaining({
			signal: expect.any(AbortSignal),
		}));
		expect(store.canShowTray).toBe(true);
		expect(store.summary?.branch).toBe('main');
	});

	it('keeps non-repositories hidden', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue({
			status: 'not-git-repository',
			project: '/project',
			fingerprintVersion: 1,
			fingerprint: null,
			message: 'not git',
		});
		const store = new GitQuickSummaryStore({ getSummary });

		store.setProject('/project');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.canShowTray).toBe(false);
		expect(store.lastNonRepoProject).toBe('/project');
	});

	it('keeps the ready summary when the selected chat uses the same project path', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		store.setProject('/project');
		await vi.advanceTimersByTimeAsync(100);
		getSummary.mockClear();

		store.setProject('/project');
		await vi.advanceTimersByTimeAsync(100);

		expect(getSummary).not.toHaveBeenCalled();
		expect(store.canShowTray).toBe(true);
		expect(store.summary?.project).toBe('/project');
	});

	it('reports a pending tray for a newly selected project before the effect adopts it', async () => {
		const getSummary = vi
			.fn<GetSummary>()
			.mockResolvedValue(readySummary({ project: '/first', repoRoot: '/first' }));
		const store = new GitQuickSummaryStore({ getSummary });
		store.setProject('/first');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.canShowTrayFor('/second')).toBe(true);
		expect(store.summary?.project).toBe('/first');
	});

	it('aborts stale work and keeps the pending tray for the next project path', async () => {
		const first = deferred<GitQuickSummaryResponse>();
		const second = deferred<GitQuickSummaryResponse>();
		const getSummary = vi
			.fn<GetSummary>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const store = new GitQuickSummaryStore({ getSummary });

		store.setProject('/first');
		await vi.advanceTimersByTimeAsync(100);
		const firstSignal = getSummary.mock.calls[0]?.[1]?.signal;

		store.setProject('/second');
		expect(firstSignal?.aborted).toBe(true);
		expect(store.canShowTray).toBe(true);
		expect(store.summary).toBeNull();

		first.resolve(readySummary({ project: '/first', repoRoot: '/first', fingerprint: 'v1:first' }));
		await vi.advanceTimersByTimeAsync(100);
		expect(getSummary).toHaveBeenCalledTimes(2);
		second.resolve(readySummary({ project: '/second', repoRoot: '/second', fingerprint: 'v1:second' }));
		await vi.waitFor(() => {
			expect(store.summary?.project).toBe('/second');
		});

		expect(store.canShowTray).toBe(true);
	});

	it('schedules a debounce refresh when processing stops', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		store.setProject('/project');
		await vi.advanceTimersByTimeAsync(100);
		getSummary.mockClear();

		store.setProcessing(true);
		store.setProcessing(false);

		await vi.advanceTimersByTimeAsync(QUICK_GIT_STOPPED_DEBOUNCE_MS - 1);
		expect(getSummary).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(getSummary).toHaveBeenCalledTimes(1);
	});

	it('calls default timers through globalThis', () => {
		vi.useRealTimers();
		const timeoutCallReceivers: unknown[] = [];
		const clearCallReceivers: unknown[] = [];
		function boundSetTimeout(this: unknown): ReturnType<typeof setTimeout> {
			timeoutCallReceivers.push(this);
			return 7 as unknown as ReturnType<typeof setTimeout>;
		}
		function boundClearTimeout(this: unknown): void {
			clearCallReceivers.push(this);
		}
		const setTimeoutSpy = vi
			.spyOn(globalThis, 'setTimeout')
			.mockImplementation(boundSetTimeout as unknown as typeof setTimeout);
		const clearTimeoutSpy = vi
			.spyOn(globalThis, 'clearTimeout')
			.mockImplementation(boundClearTimeout as typeof clearTimeout);
		const store = new GitQuickSummaryStore({ getSummary: vi.fn<GetSummary>() });

		store.setProject('/project');
		store.destroy();

		expect(timeoutCallReceivers).toEqual([globalThis]);
		expect(clearCallReceivers).toEqual([globalThis]);
		setTimeoutSpy.mockRestore();
		clearTimeoutSpy.mockRestore();
	});

	it('uses the processing polling cadence while an agent is running', () => {
		const getSummary = vi.fn<GetSummary>();
		const store = new GitQuickSummaryStore({ getSummary });
		const addEventListener = vi.fn();
		const removeEventListener = vi.fn();
		const setIntervalFn = vi.fn(() => 7 as unknown as ReturnType<typeof setInterval>);
		const clearIntervalFn = vi.fn();

		store.setProject('/project');
		store.setProcessing(true);
		const cleanup = store.startPolling({
			documentRef: {
				visibilityState: 'visible',
				addEventListener,
				removeEventListener,
			},
			setIntervalFn,
			clearIntervalFn,
		});

		expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), QUICK_GIT_PROCESSING_POLL_MS);
		cleanup();
		expect(clearIntervalFn).toHaveBeenCalledWith(7);
		expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
	});

	it('force refreshes immediately for dialog open', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		store.setProject('/project');

		await store.refresh('dialog-open');

		expect(getSummary).toHaveBeenCalledTimes(1);
		expect(store.canShowTray).toBe(true);
	});
});
