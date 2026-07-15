import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitSurfaceController } from '$lib/git/surface/git-surface.svelte.js';
import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';

const gitApi = vi.hoisted(() => ({
	getGitTargetCandidates: vi.fn(),
	getGitWorkbenchSnapshot: vi.fn(),
	getRemoteStatus: vi.fn(),
}));

vi.mock('$lib/api/git.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/api/git.js')>()),
	...gitApi,
}));

let controllers: GitSurfaceController[] = [];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function controller(): GitSurfaceController {
	const git = new GitSurfaceController({
		gitBranchActions: new GitBranchSelectorState(),
		gitMutations: new GitMutationCoordinator({ onChanged: vi.fn() }),
		getCurrentEffectiveProjectKey: () => null,
	});
	controllers.push(git);
	return git;
}

beforeEach(() => {
	controllers = [];
	gitApi.getGitTargetCandidates.mockReset().mockResolvedValue({ targets: [] });
	gitApi.getGitWorkbenchSnapshot.mockReset().mockResolvedValue({
		status: 'not-git-repository',
		project: '/project',
		target: null,
		tree: null,
		reviewSummary: null,
		selectedFile: null,
		firstBodyCandidates: [],
		message: 'Not a Git repository',
	});
	gitApi.getRemoteStatus.mockReset().mockResolvedValue({
		hasRemote: false,
		hasUpstream: false,
		branch: '',
		remoteName: null,
		ahead: 0,
		behind: 0,
		isUpToDate: true,
	});
});

afterEach(() => {
	for (const git of controllers) git.dispose();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('GitSurfaceController project snapshots', () => {
	it('retains its context and suppresses activation while project identity resolves', () => {
		const git = controller();
		const ensureTargets = vi.spyOn(git, 'ensureTargets').mockResolvedValue();
		vi.spyOn(git, 'applyActiveTarget').mockResolvedValue();
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

	it.each([
		{
			name: 'when the presentation is hidden',
			stop: (git: GitSurfaceController) => git.setPresentationVisible(false),
		},
		{
			name: 'when the controller is disposed',
			stop: (git: GitSurfaceController) => git.dispose(),
		},
	])('aborts target loading $name', async ({ stop }) => {
		const targets = deferred<{ targets: [] }>();
		gitApi.getGitTargetCandidates.mockReturnValue(targets.promise);
		const git = controller();
		git.setContext('/projects/alpha', 'alpha');
		git.presentationVisible = true;

		const loading = git.ensureTargets();
		await vi.waitFor(() => expect(gitApi.getGitTargetCandidates).toHaveBeenCalledOnce());
		const signal = gitApi.getGitTargetCandidates.mock.calls[0]?.[1]?.signal;

		stop(git);

		expect(signal?.aborted).toBe(true);
		expect(git.isLoadingTargets).toBe(false);
		targets.resolve({ targets: [] });
		await loading;
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
		git.repository.activeView = 'history';
		git.historyScreen = 'commit';
		git.workbench.files.activeTab = 'staged';
		git.workbench.files.selectedFile = 'src/alpha.ts';

		git.setContext('/projects/beta', 'beta');
		expect(git.repository.activeView).toBe('changes');
		expect(git.historyScreen).toBe('list');

		git.setContext('/projects/alpha', 'alpha');

		expect(git.activeTarget?.worktreePath).toBe('/projects/alpha/worktree');
		expect(git.repository.activeView).toBe('history');
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
		const fetchRemoteStatus = vi.spyOn(git.repository, 'fetchRemoteStatus').mockResolvedValue();

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
