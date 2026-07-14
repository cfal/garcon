import { describe, expect, it, vi } from 'vitest';
import { GitSurfaceController } from '../git-surface.svelte';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function controller(): GitSurfaceController {
	return new GitSurfaceController({
		gitBranchActions: {
			resetForProject: vi.fn(),
			currentBranch: '',
			branches: [],
			refs: [],
		} as never,
		gitMutations: {
			run: async ({ execute }: { execute: () => Promise<unknown> }) => execute(),
		} as never,
		getCurrentEffectiveProjectKey: () => null,
	});
}

describe('GitSurfaceController project snapshots', () => {
	it('retains its context and suppresses activation while project identity resolves', () => {
		const git = controller();
		const ensureTargets = vi.spyOn(git, 'ensureTargets').mockResolvedValue();
		git.setContext('/projects/alpha', 'alpha');
		git.setPresentationVisible(true);
		ensureTargets.mockClear();

		git.setProjectState({
			kind: 'resolving',
			context: { chatId: 'draft', projectPath: '/projects/alpha', effectiveProjectKey: null },
		});
		git.setPresentationVisible(false);
		git.setPresentationVisible(true);

		expect(git.baseProjectPath).toBe('/projects/alpha');
		expect(git.effectiveProjectKey).toBe('alpha');
		expect(git.projectIdentityPending).toBe(true);
		expect(ensureTargets).not.toHaveBeenCalled();

		git.setProjectState({
			kind: 'available',
			project: {
				chatId: 'chat2',
				projectPath: '/projects/alpha',
				effectiveProjectKey: 'alpha',
			},
		});
		expect(git.projectIdentityPending).toBe(false);
		expect(ensureTargets).toHaveBeenCalledOnce();
	});

	it('restores project-local target and presentation state', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => null,
			setItem: () => undefined,
		});
		const git = controller();
		git.setContext('/projects/alpha', 'alpha');
		git.activeTarget = {
			projectPath: '/projects/alpha/worktree',
			repoRoot: '/projects/alpha',
			worktreePath: '/projects/alpha/worktree',
			label: 'alpha-worktree',
			branch: 'feature',
			source: 'worktree',
		};
		git.panel.activeView = 'history';
		git.historyScreen = 'commit';
		git.workbench.files.activeTab = 'staged';
		git.workbench.files.selectedFile = 'src/alpha.ts';

		git.setContext('/projects/beta', 'beta');
		expect(git.panel.activeView).toBe('changes');
		expect(git.historyScreen).toBe('list');

		git.setContext('/projects/alpha', 'alpha');

		expect(git.activeTarget?.worktreePath).toBe('/projects/alpha/worktree');
		expect(git.panel.activeView).toBe('history');
		expect(git.historyScreen).toBe('commit');
		expect(git.workbench.files.activeTab).toBe('staged');
	});

	it('ignores stale target continuations across rapid project switches', async () => {
		const git = controller();
		const firstAlpha = deferred<void>();
		const beta = deferred<void>();
		const secondAlpha = deferred<void>();
		const pendingTargets = [firstAlpha, beta, secondAlpha];
		const setTarget = vi
			.spyOn(git.workbench, 'setTarget')
			.mockImplementation(() => pendingTargets.shift()!.promise);
		const fetchRemoteStatus = vi.spyOn(git.panel, 'fetchRemoteStatus').mockResolvedValue();

		git.setContext('/projects/alpha', 'alpha');
		git.presentationVisible = true;
		const firstAlphaActivation = git.applyActiveTarget();

		git.presentationVisible = false;
		git.setContext('/projects/beta', 'beta');
		git.presentationVisible = true;
		const betaActivation = git.applyActiveTarget();

		git.presentationVisible = false;
		git.setContext('/projects/alpha', 'alpha');
		git.presentationVisible = true;
		const secondAlphaActivation = git.applyActiveTarget();

		firstAlpha.resolve();
		await firstAlphaActivation;
		beta.resolve();
		await betaActivation;
		expect(fetchRemoteStatus).not.toHaveBeenCalled();

		secondAlpha.resolve();
		await secondAlphaActivation;

		expect(setTarget.mock.calls.map(([target]) => target?.projectPath)).toEqual([
			'/projects/alpha',
			'/projects/beta',
			'/projects/alpha',
		]);
		expect(fetchRemoteStatus).toHaveBeenCalledOnce();
		expect(fetchRemoteStatus).toHaveBeenCalledWith('/projects/alpha');
	});
});
