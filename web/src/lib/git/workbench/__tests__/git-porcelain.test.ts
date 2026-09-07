import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitConflictDetails } from '$lib/api/git.js';
import {
	GitPorcelainState,
	type GitPorcelainDeps,
} from '$lib/git/workbench/git-porcelain.svelte.js';

vi.mock('$lib/api/git.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/api/git.js')>()),
	getGitConflictDetails: vi.fn(),
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
		runGitMutation: async <T>(_projectPath: string, action: () => Promise<T>) => action(),
	} satisfies GitPorcelainDeps);
}

describe('GitPorcelainState conflict details', () => {
	beforeEach(() => {
		getGitConflictDetails.mockReset();
	});

	it('keeps the newest selection when requests resolve out of order', async () => {
		const first = deferred<GitConflictDetails>();
		const second = deferred<GitConflictDetails>();
		getGitConflictDetails
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		const porcelain = createState();

		const firstLoad = porcelain.selectConflict('/project', 'first.ts');
		const firstSignal = getGitConflictDetails.mock.calls[0][2]?.signal;
		const secondLoad = porcelain.selectConflict('/project', 'second.ts');

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

		const load = porcelain.selectConflict('/project', 'conflict.ts');
		const signal = getGitConflictDetails.mock.calls[0][2]?.signal;
		porcelain.reset();
		request.resolve(makeConflictDetails('conflict.ts'));
		await load;

		expect(signal?.aborted).toBe(true);
		expect(porcelain.conflictDetails).toBeNull();
		expect(porcelain.isLoading).toBe(false);
	});
});
