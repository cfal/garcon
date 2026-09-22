import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitConflictDetails } from '$lib/api/git.js';
import {
	GitPorcelainState,
	type GitPorcelainDeps,
} from '$lib/git/workbench/git-porcelain.svelte.js';

vi.mock('$lib/api/git.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/api/git.js')>()),
	getGitConflictDetails: vi.fn(),
	getGitStashes: vi.fn(),
	gitCreateStash: vi.fn(),
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

function createState(): GitPorcelainState {
	return new GitPorcelainState({
		selectedFile: () => null,
		refreshAfterMutation: async () => {},
		surfaceError: vi.fn(),
		ensureFreshForGitMutation: () => true,
		isCurrentTarget: () => true,
		runGitMutation: async (_project, action) => action(),
	} satisfies GitPorcelainDeps);
}

describe('GitPorcelainState conflict details', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('ignores a direct stash load after reset', async () => {
		const pending = deferred<Awaited<ReturnType<typeof gitApi.getGitStashes>>>();
		vi.mocked(gitApi.getGitStashes).mockReturnValueOnce(pending.promise);
		const porcelain = createState();
		const loading = porcelain.loadStashes({ nodeId: 'remote', projectPath: '/project' });
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
		const saving = porcelain.createStash({ nodeId: 'remote', projectPath: '/project' });
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
			{ nodeId: 'local', projectPath: '/project' },
			'first.ts',
		);
		const firstSignal = getGitConflictDetails.mock.calls[0][2]?.signal;
		const secondLoad = porcelain.selectConflict(
			{ nodeId: 'local', projectPath: '/project' },
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
			{ nodeId: 'local', projectPath: '/project' },
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
