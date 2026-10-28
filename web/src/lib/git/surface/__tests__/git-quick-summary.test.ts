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
import type { GitProjectTarget } from '$lib/api/git-client.js';

function readySummary(overrides: Partial<GitQuickSummaryReady> = {}): GitQuickSummaryReady {
	return {
		status: 'ready',
		project: '/project',
		hasChanges: true,
		hasUntracked: false,
		diffStats: { additions: 2, deletions: 1 },
		branch: 'main',
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
	project: GitProjectTarget,
	options?: ApiFetchOptions,
) => Promise<GitQuickSummaryResponse>;

function showProject(store: GitQuickSummaryStore, projectPath: string, isProcessing = false): void {
	store.setProject({ executorId: 'local', projectPath });
	store.setVisibleProjects([{ executorId: 'local', projectPath, isProcessing }]);
}

describe('GitQuickSummaryStore', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('classifies the project only after a successful response', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/project');

		expect(store.classificationFor(store.project)).toBe('unknown');
		expect(store.summary).toBeNull();
		await vi.advanceTimersByTimeAsync(100);

		expect(getSummary).toHaveBeenCalledWith(
			expect.objectContaining({ executorId: 'local', projectPath: '/project' }),
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		);
		expect(store.classificationFor(store.project)).toBe('git');
		expect(store.summary?.branch).toBe('main');
	});

	it('classifies non-repositories without deciding presentation', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue({
			status: 'not-git-repository',
			project: '/project',
			message: 'not git',
		});
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/project');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.classificationFor(store.project)).toBe('non-git');
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
		expect(store.classificationFor(store.project)).toBe('git');
		expect(store.summary?.project).toBe('/project');
	});

	it('retains a successful non-Git classification across refresh errors and detects git init later', async () => {
		const getSummary = vi
			.fn<GetSummary>()
			.mockResolvedValueOnce({
				status: 'not-git-repository',
				project: '/project',
				message: 'not git',
			})
			.mockRejectedValueOnce(new Error('Executor unavailable'))
			.mockResolvedValueOnce(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		await store.refresh('idle-poll');
		await store.refresh('idle-poll');
		expect(store.classificationFor(store.project)).toBe('non-git');
		expect(store.lastError).toBe('Executor unavailable');
		await store.refresh('idle-poll');
		expect(store.classificationFor(store.project)).toBe('git');
		store.setEnabled(false);
		expect(store.classificationFor(store.project)).toBe('git');
		store.destroy();
	});

	it('does not classify an initial failure as a non-repository', async () => {
		const store = new GitQuickSummaryStore({
			getSummary: vi.fn<GetSummary>().mockRejectedValue(new Error('offline')),
		});
		showProject(store, '/project');
		await store.refresh('idle-poll');
		expect(store.classificationFor(store.project)).toBe('unknown');
		store.destroy();
	});

	it('shows cached summary immediately when switching back to a project path', async () => {
		const getSummary = vi
			.fn<GetSummary>()
			.mockResolvedValueOnce(readySummary({ project: '/first', branch: 'branch-first' }))
			.mockResolvedValueOnce(readySummary({ project: '/second', branch: 'branch-second' }))
			.mockResolvedValueOnce(
				readySummary({
					project: '/first',
					branch: 'branch-first-refresh',
				}),
			);
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/first');
		await vi.advanceTimersByTimeAsync(100);
		expect(store.summary?.branch).toBe('branch-first');

		showProject(store, '/second');
		await vi.advanceTimersByTimeAsync(100);
		expect(store.summary?.branch).toBe('branch-second');
		expect(store.summaryFor({ executorId: 'local', projectPath: '/first' })?.branch).toBe(
			'branch-first',
		);

		showProject(store, '/first');
		expect(store.summary?.branch).toBe('branch-first');
		expect(store.classificationFor(store.project)).toBe('git');

		await vi.advanceTimersByTimeAsync(100);
		expect(store.summary?.branch).toBe('branch-first-refresh');
	});

	it('does not reuse another project classification before the effect adopts it', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary({ project: '/first' }));
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/first');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.classificationFor({ executorId: 'local', projectPath: '/second' })).toBe(
			'unknown',
		);
		expect(store.summary?.project).toBe('/first');
	});

	it('exposes cached summaries for inactive projects', async () => {
		const getSummary = vi
			.fn<GetSummary>()
			.mockResolvedValueOnce(readySummary({ project: '/first', branch: 'branch-first' }))
			.mockResolvedValueOnce(readySummary({ project: '/second', branch: 'branch-second' }));
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/first');
		await vi.advanceTimersByTimeAsync(100);
		showProject(store, '/second');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.summary?.project).toBe('/second');
		expect(store.summaryFor({ executorId: 'local', projectPath: '/first' })?.branch).toBe(
			'branch-first',
		);
		expect(store.classificationFor({ executorId: 'local', projectPath: '/first' })).toBe('git');
	});

	it('deduplicates rendered project leases and refreshes every project once', async () => {
		const getSummary = vi.fn<GetSummary>(({ projectPath: project }) =>
			Promise.resolve(readySummary({ project })),
		);
		const store = new GitQuickSummaryStore({ getSummary });

		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/first', isProcessing: false },
			{ executorId: 'local', projectPath: '/first', isProcessing: true },
			{ executorId: 'local', projectPath: '/second', isProcessing: false },
		]);
		await vi.advanceTimersByTimeAsync(100);

		expect(store.visibleProjects).toEqual([
			{ executorId: 'local', projectPath: '/first', isProcessing: true },
			{ executorId: 'local', projectPath: '/second', isProcessing: false },
		]);
		expect(getSummary).toHaveBeenCalledTimes(2);
		expect(getSummary.mock.calls.map(([{ projectPath: project }]) => project)).toEqual([
			'/first',
			'/second',
		]);
	});

	it('aborts only work whose final rendered project lease disappears', async () => {
		const first = deferred<GitQuickSummaryResponse>();
		const second = deferred<GitQuickSummaryResponse>();
		const getSummary = vi.fn<GetSummary>(({ projectPath: project }) =>
			project === '/first' ? first.promise : second.promise,
		);
		const store = new GitQuickSummaryStore({ getSummary });

		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/first', isProcessing: false },
			{ executorId: 'local', projectPath: '/second', isProcessing: false },
		]);
		await vi.advanceTimersByTimeAsync(100);
		const firstSignal = getSummary.mock.calls.find(
			([{ projectPath: project }]) => project === '/first',
		)?.[1]?.signal;
		const secondSignal = getSummary.mock.calls.find(
			([{ projectPath: project }]) => project === '/second',
		)?.[1]?.signal;

		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/second', isProcessing: false },
		]);

		expect(firstSignal?.aborted).toBe(true);
		expect(secondSignal?.aborted).toBe(false);
		first.resolve(readySummary({ project: '/first' }));
		second.resolve(readySummary({ project: '/second' }));
		await vi.waitFor(() => {
			expect(store.summaryFor({ executorId: 'local', projectPath: '/second' })?.project).toBe(
				'/second',
			);
		});
		expect(store.summaryFor({ executorId: 'local', projectPath: '/first' })).toBeNull();
	});

	it('aborts stale work and leaves the next project unclassified', async () => {
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
		expect(store.classificationFor(store.project)).toBe('unknown');
		expect(store.summary).toBeNull();

		first.resolve(readySummary({ project: '/first', branch: 'branch-first' }));
		await vi.advanceTimersByTimeAsync(100);
		expect(getSummary).toHaveBeenCalledTimes(2);
		second.resolve(readySummary({ project: '/second', branch: 'branch-second' }));
		await vi.waitFor(() => {
			expect(store.summary?.project).toBe('/second');
		});

		expect(store.classificationFor(store.project)).toBe('git');
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
			.mockResolvedValueOnce(readySummary({ branch: 'branch-ready' }))
			.mockRejectedValueOnce(new Error('quick summary failed'));
		const store = new GitQuickSummaryStore({ getSummary });

		showProject(store, '/project');
		await vi.advanceTimersByTimeAsync(100);

		await store.refresh('idle-poll');

		expect(store.summary?.branch).toBe('branch-ready');
		expect(store.lastError).toBe('quick summary failed');
		expect(store.classificationFor(store.project)).toBe('git');
		expect(store.isLoading).toBe(false);
	});

	it('prunes least recently accessed inactive projects when the cache exceeds the limit', async () => {
		let now = 0;
		const getSummary = vi.fn<GetSummary>(({ projectPath: project }) =>
			Promise.resolve(readySummary({ project, branch: `branch-${project}` })),
		);
		const store = new GitQuickSummaryStore({ getSummary, nowFn: () => now });

		for (let index = 0; index < QUICK_GIT_CACHE_MAX_ENTRIES + 2; index += 1) {
			now += 1;
			showProject(store, `/project-${index}`);
			await vi.advanceTimersByTimeAsync(100);
		}

		expect(Object.keys(store.entries)).toHaveLength(QUICK_GIT_CACHE_MAX_ENTRIES);
		expect(store.summaryFor({ executorId: 'local', projectPath: '/project-0' })).toBeNull();
		expect(store.summaryFor({ executorId: 'local', projectPath: '/project-1' })).toBeNull();
		expect(store.summaryFor({ executorId: 'local', projectPath: '/project-2' })?.branch).toBe(
			'branch-/project-2',
		);
		expect(store.summary?.project).toBe(`/project-${QUICK_GIT_CACHE_MAX_ENTRIES + 1}`);
	});

	it('prunes inactive projects after the cache age window', async () => {
		let now = 0;
		const getSummary = vi.fn<GetSummary>(({ projectPath: project }) =>
			Promise.resolve(readySummary({ project, branch: `branch-${project}` })),
		);
		const store = new GitQuickSummaryStore({ getSummary, nowFn: () => now });

		showProject(store, '/old');
		await vi.advanceTimersByTimeAsync(100);
		expect(store.summaryFor({ executorId: 'local', projectPath: '/old' })?.branch).toBe(
			'branch-/old',
		);

		now = QUICK_GIT_CACHE_MAX_AGE_MS + 1;
		showProject(store, '/active');
		await vi.advanceTimersByTimeAsync(100);

		expect(store.summaryFor({ executorId: 'local', projectPath: '/old' })).toBeNull();
		expect(store.summary?.project).toBe('/active');
	});

	it('schedules a debounce refresh when processing stops', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		await vi.advanceTimersByTimeAsync(100);
		getSummary.mockClear();

		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/project', isProcessing: true },
		]);
		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/project', isProcessing: false },
		]);

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
			{ executorId: 'local', projectPath: '/processing', isProcessing: true },
			{ executorId: 'local', projectPath: '/idle', isProcessing: false },
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

		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/project', isProcessing: false },
		]);
		store.reconcilePolling(pollingOptions);
		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/project', isProcessing: false },
			{ executorId: 'local', projectPath: '/project', isProcessing: false },
		]);
		store.reconcilePolling(pollingOptions);

		expect(setIntervalFn).toHaveBeenCalledOnce();
		expect(clearIntervalFn).not.toHaveBeenCalled();

		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/project', isProcessing: true },
		]);
		store.reconcilePolling(pollingOptions);
		expect(clearIntervalFn).toHaveBeenCalledOnce();
		expect(setIntervalFn).toHaveBeenCalledTimes(2);
		store.destroy();
	});

	it('does not poll or refresh a selected project without a rendered lease', async () => {
		const getSummary = vi.fn<GetSummary>();
		const store = new GitQuickSummaryStore({ getSummary });
		const setIntervalFn = vi.fn(() => 7 as unknown as ReturnType<typeof setInterval>);
		store.setProject({ executorId: 'local', projectPath: '/hidden' });

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
		expect(store.classificationFor(store.project)).toBe('git');
	});

	it('lets a slow summary finish across multiple polls and visibility refreshes', async () => {
		const pending = deferred<GitQuickSummaryResponse>();
		const getSummary = vi.fn<GetSummary>().mockReturnValue(pending.promise);
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		const stop = store.startPolling();
		await vi.advanceTimersByTimeAsync(100);
		const signal = getSummary.mock.calls[0]?.[1]?.signal;
		await vi.advanceTimersByTimeAsync(QUICK_GIT_IDLE_POLL_MS * 3);
		const visibilityRefresh = store.refresh('visibility');
		expect(getSummary).toHaveBeenCalledOnce();
		expect(signal?.aborted).toBe(false);
		pending.resolve(readySummary());
		await visibilityRefresh;
		expect(store.summary?.branch).toBe('main');
		expect(store.isLoading).toBe(false);
		stop();
		store.destroy();
	});

	it('coalesces mutations during a read into one follow-up, even across a poll', async () => {
		const first = deferred<GitQuickSummaryResponse>();
		const second = deferred<GitQuickSummaryResponse>();
		const getSummary = vi
			.fn<GetSummary>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		const initial = store.refresh('dialog-open');
		const signal = getSummary.mock.calls[0]?.[1]?.signal;
		store.scheduleRefresh('dialog-mutation');
		store.scheduleRefresh('invalidation');
		store.scheduleRefresh('commit-complete');
		void store.refresh('idle-poll');
		await vi.advanceTimersByTimeAsync(1000);
		expect(getSummary).toHaveBeenCalledOnce();
		expect(signal?.aborted).toBe(false);
		first.resolve(readySummary({ branch: 'before-mutation' }));
		await initial;
		expect(getSummary).toHaveBeenCalledTimes(2);
		expect(store.summary?.branch).toBe('before-mutation');
		expect(store.isLoading).toBe(true);
		second.resolve(readySummary({ branch: 'after-mutation' }));
		await vi.advanceTimersByTimeAsync(1000);
		expect(getSummary).toHaveBeenCalledTimes(2);
		expect(store.summary?.branch).toBe('after-mutation');
		expect(store.isLoading).toBe(false);
		store.destroy();
	});

	it.each(
		(['disable', 'remove', 'context', 'destroy'] as const).flatMap((action) =>
			(['scheduled', 'queued'] as const).map((phase) => [action, phase] as const),
		),
	)(
		'fences the old response on %s with a %s follow-up',
		async (action, phase) => {
			const pending = deferred<GitQuickSummaryResponse>();
			const getSummary = vi.fn<GetSummary>().mockReturnValue(pending.promise);
			const store = new GitQuickSummaryStore({ getSummary });
			showProject(store, '/project');
			const refresh = store.refresh('dialog-open');
			const signal = getSummary.mock.calls[0]?.[1]?.signal;
			store.scheduleRefresh('invalidation');
			if (phase === 'queued') await vi.advanceTimersByTimeAsync(300);
			if (action === 'disable') store.setEnabled(false);
			if (action === 'remove') store.setVisibleProjects([]);
			if (action === 'destroy') store.destroy();
			if (action === 'context')
				store.setVisibleProjects([
					{
						executorId: 'local',
						projectPath: '/project',
						isProcessing: false,
						executorContextKey: 'replacement',
					},
				]);
			expect(signal?.aborted).toBe(true);
			pending.resolve(readySummary({ branch: 'obsolete' }));
			await refresh;
			expect(store.summary).toBeNull();
			expect(getSummary).toHaveBeenCalledOnce();
			store.destroy();
		},
	);

	it('awaits the post-mutation summary when a mutation joins an active read', async () => {
		const first = deferred<GitQuickSummaryResponse>();
		const second = deferred<GitQuickSummaryResponse>();
		const getSummary = vi
			.fn<GetSummary>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		const initial = store.refresh('dialog-open');
		let mutationFinished = false;
		let branchAtMutationCompletion: string | undefined;
		const mutation = store.refresh('invalidation').then(() => {
			mutationFinished = true;
			branchAtMutationCompletion = store.summary?.branch;
		});
		first.resolve(readySummary({ branch: 'before-mutation' }));
		await initial;
		await vi.advanceTimersByTimeAsync(0);
		expect(mutationFinished).toBe(false);
		expect(store.summary?.branch).toBe('before-mutation');
		expect(getSummary).toHaveBeenCalledTimes(2);
		second.resolve(readySummary({ branch: 'after-mutation' }));
		await mutation;
		expect(branchAtMutationCompletion).toBe('after-mutation');
		expect(store.summary?.branch).toBe('after-mutation');
		expect(mutationFinished).toBe(true);
		store.destroy();
	});

	it.each(['success', 'failure'] as const)(
		'keeps a replacement read active when an obsolete read settles with %s',
		async (outcome) => {
			const obsolete = deferred<GitQuickSummaryResponse>();
			const replacement = deferred<GitQuickSummaryResponse>();
			const getSummary = vi
				.fn<GetSummary>()
				.mockReturnValueOnce(obsolete.promise)
				.mockReturnValueOnce(replacement.promise);
			const store = new GitQuickSummaryStore({ getSummary });
			showProject(store, '/project');
			const initial = store.refresh('dialog-open');
			store.scheduleRefresh('invalidation');
			await vi.advanceTimersByTimeAsync(300);
			const obsoleteSignal = getSummary.mock.calls[0]?.[1]?.signal;
			store.setVisibleProjects([
				{
					executorId: 'local',
					projectPath: '/project',
					isProcessing: false,
					executorContextKey: 'replacement',
				},
			]);
			const refreshed = store.refresh('dialog-open');
			const replacementSignal = getSummary.mock.calls[1]?.[1]?.signal;
			expect(obsoleteSignal?.aborted).toBe(true);
			if (outcome === 'success') obsolete.resolve(readySummary({ branch: 'obsolete' }));
			else obsolete.reject(new Error('obsolete error'));
			await initial;
			expect(store.summary).toBeNull();
			expect(store.lastError).toBeNull();
			expect(store.isLoading).toBe(true);
			const joined = store.refresh('idle-poll');
			expect(getSummary).toHaveBeenCalledTimes(2);
			expect(replacementSignal?.aborted).toBe(false);
			replacement.resolve(readySummary({ branch: 'replacement' }));
			await Promise.all([refreshed, joined]);
			expect(store.summary?.branch).toBe('replacement');
			expect(store.isLoading).toBe(false);
			store.destroy();
		},
	);

	it('resets the debounce deadline and preserves the latest scheduled reason', async () => {
		const pending = deferred<GitQuickSummaryResponse>();
		const getSummary = vi
			.fn<GetSummary>()
			.mockResolvedValueOnce(readySummary())
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue(readySummary({ branch: 'after-mutation' }));
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		await store.refresh('dialog-open');
		store.scheduleRefresh('visibility');
		await vi.advanceTimersByTimeAsync(200);
		store.scheduleRefresh('invalidation');
		await vi.advanceTimersByTimeAsync(100);
		expect(getSummary).toHaveBeenCalledOnce();
		const refresh = store.refresh('idle-poll');
		await vi.advanceTimersByTimeAsync(199);
		expect(getSummary).toHaveBeenCalledTimes(2);
		pending.resolve(readySummary({ branch: 'before-mutation' }));
		await refresh;
		expect(getSummary).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(getSummary).toHaveBeenCalledTimes(3);
		expect(store.summary?.branch).toBe('after-mutation');
		store.destroy();
	});

	it('retains the stopped debounce when an active read finishes before the settling window', async () => {
		const pending = deferred<GitQuickSummaryResponse>();
		const getSummary = vi
			.fn<GetSummary>()
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project', true);
		const initial = store.refresh('dialog-open');
		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/project', isProcessing: false },
		]);
		pending.resolve(readySummary());
		await initial;
		await vi.advanceTimersByTimeAsync(QUICK_GIT_STOPPED_DEBOUNCE_MS - 1);
		expect(getSummary).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(getSummary).toHaveBeenCalledTimes(2);
		store.destroy();
	});

	it('keeps a stopped refresh scheduled when an idle poll finishes inside its settling window', async () => {
		const getSummary = vi.fn<GetSummary>().mockResolvedValue(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project', true);
		await store.refresh('dialog-open');
		getSummary.mockClear();
		store.setVisibleProjects([
			{ executorId: 'local', projectPath: '/project', isProcessing: false },
		]);
		await store.refresh('idle-poll');
		await vi.advanceTimersByTimeAsync(QUICK_GIT_STOPPED_DEBOUNCE_MS - 1);
		expect(getSummary).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(getSummary).toHaveBeenCalledTimes(2);
		store.destroy();
	});

	it('clears a cached first-load error after returning to the project and succeeding', async () => {
		const getSummary = vi
			.fn<GetSummary>()
			.mockRejectedValueOnce(new Error('status timed out'))
			.mockResolvedValueOnce(readySummary());
		const store = new GitQuickSummaryStore({ getSummary });
		showProject(store, '/project');
		await store.refresh('dialog-open');
		expect(store.lastError).toBe('status timed out');
		store.setVisibleProjects([]);
		showProject(store, '/project');
		await store.refresh('dialog-open');
		expect(store.lastError).toBeNull();
		expect(store.summary?.branch).toBe('main');
		store.destroy();
	});
});
