import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GitQuickSummaryStore,
	QUICK_GIT_CACHE_MAX_AGE_MS,
	QUICK_GIT_CACHE_MAX_ENTRIES,
	QUICK_GIT_IDLE_POLL_MS,
	QUICK_GIT_PROCESSING_POLL_MS,
	QUICK_GIT_STOPPED_DEBOUNCE_MS,
} from '$lib/git/surface/git-quick-summary.svelte.js';
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

type GetSummary = (project: string, options?: ApiFetchOptions) => Promise<GitQuickSummaryResponse>;

function showProject(
	store: GitQuickSummaryStore,
	projectPath: string,
	isProcessing = false,
): void {
	store.setProject(projectPath);
	store.setVisibleProjects([{ projectPath, isProcessing }]);
}

describe('GitQuickSummaryStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('shows a quiet pending tray until a ready response arrives for the current project', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/project');

		expect(store.canShowTray).toBe(true);
		expect(store.summary).toBeNull();
		await vi.advanceTimersByTimeAsync(100);

		expect(getSummary).toHaveBeenCalledWith(
			'/project',
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		);
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

		showProject(store, '/project');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.canShowTray).toBe(false);
		expect(store.lastNonRepoProject).toBe('/project');
	});

	it('keeps the ready summary when the selected chat uses the same project path', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		await vi.advanceTimersByTimeAsync(100);
		getSummary.mockClear();

		showProject(store, '/project');
		await vi.advanceTimersByTimeAsync(100);

		expect(getSummary).not.toHaveBeenCalled();
		expect(store.canShowTray).toBe(true);
		expect(store.summary?.project).toBe('/project');
	});

	it('shows cached summary immediately when switching back to a project path', async () => {
		const getSummary = vi
			.fn<GetSummary>()
			.mockResolvedValueOnce(
				readySummary({ project: '/first', repoRoot: '/first', fingerprint: 'v1:first' }),
			)
			.mockResolvedValueOnce(
				readySummary({ project: '/second', repoRoot: '/second', fingerprint: 'v1:second' }),
			)
			.mockResolvedValueOnce(
				readySummary({
					project: '/first',
					repoRoot: '/first',
					fingerprint: 'v1:first-refresh',
				}),
			);
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/first');
		await vi.advanceTimersByTimeAsync(100);
		expect(store.summary?.fingerprint).toBe('v1:first');

		showProject(store, '/second');
		await vi.advanceTimersByTimeAsync(100);
		expect(store.summary?.fingerprint).toBe('v1:second');
		expect(store.summaryFor('/first')?.fingerprint).toBe('v1:first');

		showProject(store, '/first');
		expect(store.summary?.fingerprint).toBe('v1:first');
		expect(store.canShowTray).toBe(true);

		await vi.advanceTimersByTimeAsync(100);
		expect(store.summary?.fingerprint).toBe('v1:first-refresh');
	});

	it('reports a pending tray for a newly selected project before the effect adopts it', async () => {
		const getSummary = vi
			.fn<GetSummary>()
			.mockResolvedValue(readySummary({ project: '/first', repoRoot: '/first' }));
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/first');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.canShowTrayFor('/second')).toBe(true);
		expect(store.summary?.project).toBe('/first');
	});

	it('exposes cached summaries for inactive projects', async () => {
		const getSummary = vi
			.fn<GetSummary>()
			.mockResolvedValueOnce(
				readySummary({ project: '/first', repoRoot: '/first', fingerprint: 'v1:first' }),
			)
			.mockResolvedValueOnce(
				readySummary({ project: '/second', repoRoot: '/second', fingerprint: 'v1:second' }),
			);
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/first');
		await vi.advanceTimersByTimeAsync(100);
		showProject(store, '/second');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.summary?.project).toBe('/second');
		expect(store.summaryFor('/first')?.fingerprint).toBe('v1:first');
		expect(store.canShowTrayFor('/first')).toBe(true);
	});

	it('deduplicates rendered project leases and refreshes every project once', async () => {
		const getSummary = vi.fn<GetSummary>((project) =>
			Promise.resolve(readySummary({ project, repoRoot: project })),
		);
		const store = new GitQuickSummaryStore({ getSummary });

		store.setVisibleProjects([
			{ projectPath: '/first', isProcessing: false },
			{ projectPath: '/first', isProcessing: true },
			{ projectPath: '/second', isProcessing: false },
		]);
		await vi.advanceTimersByTimeAsync(100);

		expect(store.visibleProjects).toEqual([
			{ projectPath: '/first', isProcessing: true },
			{ projectPath: '/second', isProcessing: false },
		]);
		expect(getSummary).toHaveBeenCalledTimes(2);
		expect(getSummary.mock.calls.map(([project]) => project)).toEqual(['/first', '/second']);
	});

	it('aborts only work whose final rendered project lease disappears', async () => {
		const first = deferred<GitQuickSummaryResponse>();
		const second = deferred<GitQuickSummaryResponse>();
		const getSummary = vi.fn<GetSummary>((project) =>
			project === '/first' ? first.promise : second.promise,
		);
		const store = new GitQuickSummaryStore({ getSummary });

		store.setVisibleProjects([
			{ projectPath: '/first', isProcessing: false },
			{ projectPath: '/second', isProcessing: false },
		]);
		await vi.advanceTimersByTimeAsync(100);
		const firstSignal = getSummary.mock.calls.find(([project]) => project === '/first')?.[1]?.signal;
		const secondSignal = getSummary.mock.calls.find(([project]) => project === '/second')?.[1]
			?.signal;

		store.setVisibleProjects([{ projectPath: '/second', isProcessing: false }]);

		expect(firstSignal?.aborted).toBe(true);
		expect(secondSignal?.aborted).toBe(false);
		first.resolve(readySummary({ project: '/first', repoRoot: '/first' }));
		second.resolve(readySummary({ project: '/second', repoRoot: '/second' }));
		await vi.waitFor(() => {
			expect(store.summaryFor('/second')?.project).toBe('/second');
		});
		expect(store.summaryFor('/first')).toBeNull();
	});

	it('aborts stale work and keeps the pending tray for the next project path', async () => {
		const first = deferred<GitQuickSummaryResponse>();
		const second = deferred<GitQuickSummaryResponse>();
		const getSummary = vi
			.fn<GetSummary>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/first');
		await vi.advanceTimersByTimeAsync(100);
		const firstSignal = getSummary.mock.calls[0]?.[1]?.signal;

		showProject(store, '/second');
		expect(firstSignal?.aborted).toBe(true);
		expect(store.canShowTray).toBe(true);
		expect(store.summary).toBeNull();

		first.resolve(readySummary({ project: '/first', repoRoot: '/first', fingerprint: 'v1:first' }));
		await vi.advanceTimersByTimeAsync(100);
		expect(getSummary).toHaveBeenCalledTimes(2);
		second.resolve(
			readySummary({ project: '/second', repoRoot: '/second', fingerprint: 'v1:second' }),
		);
		await vi.waitFor(() => {
			expect(store.summary?.project).toBe('/second');
		});

		expect(store.canShowTray).toBe(true);
	});

	it('aborts an in-flight summary refresh when destroyed', async () => {
		const pending = deferred<GitQuickSummaryResponse>();
		const getSummary = vi.fn<GetSummary>().mockReturnValue(pending.promise);
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		const refresh = store.refresh('dialog-open');
		const signal = getSummary.mock.calls[0]?.[1]?.signal;

		store.destroy();

		expect(signal?.aborted).toBe(true);
		expect(store.entries).toEqual({});
		pending.resolve(readySummary());
		await refresh;
	});

	it('keeps cached ready summary visible when a refresh fails', async () => {
		const getSummary = vi
			.fn<GetSummary>()
			.mockResolvedValueOnce(readySummary({ fingerprint: 'v1:ready' }))
			.mockRejectedValueOnce(new Error('quick summary failed'));
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/project');
		await vi.advanceTimersByTimeAsync(100);

		await store.refresh('idle-poll');

		expect(store.summary?.fingerprint).toBe('v1:ready');
		expect(store.lastError).toBe('quick summary failed');
		expect(store.canShowTray).toBe(true);
		expect(store.isLoading).toBe(false);
	});

	it('prunes least recently accessed inactive projects when the cache exceeds the limit', async () => {
		let now = 0;
		const getSummary = vi.fn<GetSummary>((project) =>
			Promise.resolve(readySummary({ project, repoRoot: project, fingerprint: `v1:${project}` })),
		);
		const store = new GitQuickSummaryStore({ getSummary, nowFn: () => now });

		for (let index = 0; index < QUICK_GIT_CACHE_MAX_ENTRIES + 2; index += 1) {
			now += 1;
			showProject(store, `/project-${index}`);
			await vi.advanceTimersByTimeAsync(100);
		}

		expect(Object.keys(store.entries)).toHaveLength(QUICK_GIT_CACHE_MAX_ENTRIES);
		expect(store.summaryFor('/project-0')).toBeNull();
		expect(store.summaryFor('/project-1')).toBeNull();
		expect(store.summaryFor('/project-2')?.fingerprint).toBe('v1:/project-2');
		expect(store.summary?.project).toBe(`/project-${QUICK_GIT_CACHE_MAX_ENTRIES + 1}`);
	});

	it('prunes inactive projects after the cache age window', async () => {
		let now = 0;
		const getSummary = vi.fn<GetSummary>((project) =>
			Promise.resolve(readySummary({ project, repoRoot: project, fingerprint: `v1:${project}` })),
		);
		const store = new GitQuickSummaryStore({ getSummary, nowFn: () => now });

		showProject(store, '/old');
		await vi.advanceTimersByTimeAsync(100);
		expect(store.summaryFor('/old')?.fingerprint).toBe('v1:/old');

		now = QUICK_GIT_CACHE_MAX_AGE_MS + 1;
		showProject(store, '/active');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.summaryFor('/old')).toBeNull();
		expect(store.summary?.project).toBe('/active');
	});

	it('schedules a debounce refresh when processing stops', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		await vi.advanceTimersByTimeAsync(100);
		getSummary.mockClear();

		store.setVisibleProjects([{ projectPath: '/project', isProcessing: true }]);
		store.setVisibleProjects([{ projectPath: '/project', isProcessing: false }]);

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

		showProject(store, '/project');
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

		showProject(store, '/project', true);
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

	it('uses the idle cadence for mixed rendered projects', () => {
		const store = new GitQuickSummaryStore({ getSummary: vi.fn<GetSummary>() });
		const setIntervalFn = vi.fn(() => 7 as unknown as ReturnType<typeof setInterval>);

		store.setVisibleProjects([
			{ projectPath: '/processing', isProcessing: true },
			{ projectPath: '/idle', isProcessing: false },
		]);
		const cleanup = store.startPolling({
			documentRef: {
				visibilityState: 'visible',
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			},
			setIntervalFn,
			clearIntervalFn: vi.fn(),
		});

		expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), QUICK_GIT_IDLE_POLL_MS);
		cleanup();
	});

	it('keeps the owned polling interval across equivalent lease reconciliation', () => {
		const store = new GitQuickSummaryStore({ getSummary: vi.fn<GetSummary>() });
		const setIntervalFn = vi.fn(() => 7 as unknown as ReturnType<typeof setInterval>);
		const clearIntervalFn = vi.fn();
		const pollingOptions = {
			documentRef: {
				visibilityState: 'visible' as const,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			},
			setIntervalFn,
			clearIntervalFn,
		};

		store.setVisibleProjects([{ projectPath: '/project', isProcessing: false }]);
		store.reconcilePolling(pollingOptions);
		store.setVisibleProjects([
			{ projectPath: '/project', isProcessing: false },
			{ projectPath: '/project', isProcessing: false },
		]);
		store.reconcilePolling(pollingOptions);

		expect(setIntervalFn).toHaveBeenCalledOnce();
		expect(clearIntervalFn).not.toHaveBeenCalled();

		store.setVisibleProjects([{ projectPath: '/project', isProcessing: true }]);
		store.reconcilePolling(pollingOptions);
		expect(clearIntervalFn).toHaveBeenCalledOnce();
		expect(setIntervalFn).toHaveBeenCalledTimes(2);
		store.destroy();
	});

	it('does not poll or refresh a selected project without a rendered lease', async () => {
		const getSummary = vi.fn<GetSummary>();
		const store = new GitQuickSummaryStore({ getSummary });
		const setIntervalFn = vi.fn(() => 7 as unknown as ReturnType<typeof setInterval>);
		store.setProject('/hidden');

		const cleanup = store.startPolling({ setIntervalFn });
		await store.refresh('dialog-open');

		expect(setIntervalFn).not.toHaveBeenCalled();
		expect(getSummary).not.toHaveBeenCalled();
		cleanup();
	});

	it('force refreshes immediately for dialog open', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');

		await store.refresh('dialog-open');

		expect(getSummary).toHaveBeenCalledTimes(1);
		expect(store.canShowTray).toBe(true);
	});
});
