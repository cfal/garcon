import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import type { GitConflictDetails, GitStashEntry } from '$lib/api/git.js';
import {
	GitPorcelainState,
	type GitPorcelainDeps,
} from '$lib/git/workbench/git-porcelain.svelte.js';

vi.mock('$lib/api/git.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/api/git.js')>()),
	getGitConflictDetails: vi.fn(),
	getGitStashes: vi.fn(),
	gitCreateStash: vi.fn(),
	gitApplyStash: vi.fn(),
	gitPopStash: vi.fn(),
	gitDropStash: vi.fn(),
}));

const gitApi = await import('$lib/api/git.js');
const getGitConflictDetails = vi.mocked(gitApi.getGitConflictDetails);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function makeConflictDetails(path: string): GitConflictDetails {
	const content = {
		content: path,
		truncated: false,
		byteLength: path.length,
		lineCount: 1,
	};
	return {
		path,
		base: content,
		ours: content,
		theirs: content,
		working: content,
		truncated: false,
	};
}

function createState(overrides: Partial<GitPorcelainDeps> = {}): GitPorcelainState {
	return new GitPorcelainState({
		selectedFile: () => null,
		refreshAfterMutation: async () => {},
		surfaceError: vi.fn(),
		ensureFreshForGitMutation: () => true,
		isCurrentTarget: () => true,
		runGitMutation: async (_project, action) => action(),
		...overrides,
	} satisfies GitPorcelainDeps);
}

function makeStash(index: number, hash: string, message: string): GitStashEntry {
	return { index, ref: `stash@{${index}}`, hash, message, date: '2026-01-01 00:00:00 +0000' };
}

const stashActions = [
	['applyStash', 'gitApplyStash', 'apply'],
	['popStash', 'gitPopStash', 'pop'],
	['dropStash', 'gitDropStash', 'drop'],
] as const;

describe('GitPorcelainState stash actions', () => {
	const project = { executorId: 'remote', projectPath: '/project' };

	beforeEach(() => {
		vi.resetAllMocks();
	});

	it.each(stashActions)(
		'%s submits the selector and commit chosen when the action started',
		async (method, request) => {
			const gate = deferred<void>();
			vi.mocked(gitApi[request]).mockResolvedValueOnce({ success: true });
			vi.mocked(gitApi.getGitStashes).mockResolvedValue({ stashes: [] });
			const porcelain = createState({
				runGitMutation: async (_project, action) => {
					await gate.promise;
					return action();
				},
			});
			const stash = makeStash(1, 'b'.repeat(40), 'Chosen stash');
			const acting = porcelain[method](project, stash);
			Object.assign(stash, makeStash(1, 'c'.repeat(40), 'Stash now at the same selector'));
			gate.resolve();
			await acting;
			expect(gitApi[request]).toHaveBeenCalledWith(project, {
				ref: 'stash@{1}',
				hash: 'b'.repeat(40),
			});
		},
	);

	it.each(stashActions)(
		'%s reloads the list after a stale selection without retrying',
		async (method, request, verb) => {
			const current = makeStash(0, 'd'.repeat(40), 'Current stash');
			const message = 'The stash list changed since it was loaded. Select the stash again from the current list.';
			vi.mocked(gitApi[request]).mockRejectedValueOnce(new ApiError(409, message, 'GIT_STALE_STASH'));
			vi.mocked(gitApi.getGitStashes).mockResolvedValueOnce({ stashes: [current] });
			const surfaceError = vi.fn();
			const porcelain = createState({ surfaceError });
			await porcelain[method](project, makeStash(0, 'b'.repeat(40), 'Listed stash'));
			expect(gitApi[request]).toHaveBeenCalledTimes(1);
			expect(gitApi.getGitStashes).toHaveBeenCalledTimes(1);
			expect(porcelain.stashes).toEqual([current]);
			expect(surfaceError).toHaveBeenCalledWith(`Failed to ${verb} stash: ${message}`);
			expect(porcelain.isLoading).toBe(false);
		},
	);
});

describe('GitPorcelainState conflict details', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('ignores a direct stash load after reset', async () => {
		const pending = deferred<Awaited<ReturnType<typeof gitApi.getGitStashes>>>();
		vi.mocked(gitApi.getGitStashes).mockReturnValueOnce(pending.promise);
		const porcelain = createState();
		const loading = porcelain.loadStashes({ executorId: 'remote', projectPath: '/project' });
		porcelain.reset();
		pending.resolve({
			stashes: [
				{
					ref: 'stash@{0}',
					index: 0,
					hash: 'a'.repeat(40),
					message: 'Old stash',
					date: '2026-01-01',
				},
			],
		});
		await loading;
		expect(porcelain.stashes).toEqual([]);
		expect(porcelain.isLoading).toBe(false);
	});

	it('does not clear a new stash draft after an old mutation completes', async () => {
		const pending = deferred<Awaited<ReturnType<typeof gitApi.gitCreateStash>>>();
		vi.mocked(gitApi.gitCreateStash).mockReturnValueOnce(pending.promise);
		const porcelain = createState();
		porcelain.stashMessage = 'Original stash';
		const saving = porcelain.createStash({ executorId: 'remote', projectPath: '/project' });
		porcelain.reset();
		porcelain.stashMessage = 'New target draft';
		pending.resolve({ success: true });
		await saving;
		expect(porcelain.stashMessage).toBe('New target draft');
		expect(gitApi.getGitStashes).not.toHaveBeenCalled();
	});

	it('keeps the newest selection when requests resolve out of order', async () => {
		const first = deferred<GitConflictDetails>();
		const second = deferred<GitConflictDetails>();
		getGitConflictDetails
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		const porcelain = createState();

		const firstLoad = porcelain.selectConflict(
			{ executorId: 'local', projectPath: '/project' },
			'first.ts',
		);
		const firstSignal = getGitConflictDetails.mock.calls[0][2]?.signal;
		const secondLoad = porcelain.selectConflict(
			{ executorId: 'local', projectPath: '/project' },
			'second.ts',
		);

		expect(firstSignal?.aborted).toBe(true);
		second.resolve(makeConflictDetails('second.ts'));
		await secondLoad;
		first.resolve(makeConflictDetails('first.ts'));
		await firstLoad;

		expect(porcelain.conflictDetails?.path).toBe('second.ts');
		expect(porcelain.isLoading).toBe(false);
	});

	it('does not restore conflict details after reset', async () => {
		const request = deferred<GitConflictDetails>();
		getGitConflictDetails.mockImplementationOnce(() => request.promise);
		const porcelain = createState();

		const load = porcelain.selectConflict(
			{ executorId: 'local', projectPath: '/project' },
			'conflict.ts',
		);
		const signal = getGitConflictDetails.mock.calls[0][2]?.signal;
		porcelain.reset();
		request.resolve(makeConflictDetails('conflict.ts'));
		await load;

		expect(signal?.aborted).toBe(true);
		expect(porcelain.conflictDetails).toBeNull();
		expect(porcelain.isLoading).toBe(false);
	});
});
