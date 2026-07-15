import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CommitController,
	type CommitControllerDeps,
} from '$lib/git/commit/commit-controller.svelte.js';
import type { GitChangesTreeResult, GitTreeNode, GitWorkbenchSnapshotReady } from '$lib/api/git.js';

vi.mock('$lib/api/git.js', () => ({
	getGitWorkbenchSnapshot: vi.fn(),
	gitStagePaths: vi.fn(),
	gitCommitIndex: vi.fn(),
	generateCommitMessage: vi.fn(),
}));

const gitApi = await import('$lib/api/git.js');
const mockedApi = vi.mocked(gitApi);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function fileNode(path: string, overrides: Partial<GitTreeNode> = {}): GitTreeNode {
	const name = path.split('/').pop() ?? path;
	const staged = overrides.staged ?? false;
	const hasUnstaged = overrides.hasUnstaged ?? !staged;
	const changeKind = overrides.changeKind ?? (staged ? 'added' : 'modified');
	const stats = { additions: overrides.additions ?? 1, deletions: overrides.deletions ?? 0 };
	return {
		path,
		name,
		kind: 'file',
		indexStatus: staged ? 'A' : ' ',
		workTreeStatus: hasUnstaged ? 'M' : ' ',
		staged,
		hasUnstaged,
		changeKind,
		additions: stats.additions,
		deletions: stats.deletions,
		...(staged
			? {
					stagedFacet: {
						status: 'A',
						changeKind,
						stats,
						category: 'normal',
					},
				}
			: {}),
		...(hasUnstaged
			? {
					unstagedFacet: {
						status: changeKind === 'untracked' ? '?' : 'M',
						changeKind,
						stats,
						category: 'normal',
					},
				}
			: {}),
		...overrides,
	};
}

function directoryNode(
	path: string,
	children: GitTreeNode[],
	overrides: Partial<GitTreeNode> = {},
): GitTreeNode {
	const name = path.split('/').pop() ?? path;
	return {
		path,
		name,
		kind: 'directory',
		indexStatus: children.some((child) => child.staged) ? 'M' : ' ',
		workTreeStatus: children.some((child) => child.hasUnstaged) ? 'M' : ' ',
		staged: children.some((child) => child.staged),
		hasUnstaged: children.some((child) => child.hasUnstaged),
		additions: children.reduce((sum, child) => sum + (child.additions ?? 0), 0),
		deletions: children.reduce((sum, child) => sum + (child.deletions ?? 0), 0),
		children,
		...overrides,
	};
}

function snapshot(root: GitTreeNode[]): GitWorkbenchSnapshotReady {
	const tree: GitChangesTreeResult & { statsState: 'loaded' } = {
		root,
		hasCommits: true,
		statsState: 'loaded',
	};
	return {
		status: 'ready',
		project: '/project',
		target: {
			projectPath: '/project',
			repoRoot: '/project',
			worktreePath: '/project',
			label: 'project',
			branch: 'main',
			source: 'chat-project',
		},
		tree,
		reviewSummary: {
			documentId: 'doc',
			project: '/project',
			mode: 'working',
			context: 0,
			files: [],
			limits: {
				maxSummaryFiles: 10_000,
				maxBodyBatchFiles: 24,
				maxLoadedRows: 100_000,
				maxLoadedPatchBytes: 10_000_000,
				maxFileRows: 50_000,
				maxFilePatchBytes: 5_000_000,
				maxLineBytes: 20_000,
				maxContextLines: 50,
				bodyConcurrency: 4,
			},
		},
		selectedFile: root[0]?.path ?? null,
		firstBodyCandidates: [],
		snapshotId: 'doc',
		workbenchFingerprint: 'v1:workbench',
	};
}

function makeController(overrides: Partial<CommitControllerDeps> = {}) {
	return new CommitController({
		refreshSummary: vi.fn().mockResolvedValue(undefined),
		markProjectChanged: vi.fn(),
		...overrides,
	});
}

describe('CommitController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
			snapshot([
				fileNode('staged.ts', { staged: true, hasUnstaged: false }),
				fileNode('unstaged.ts', { staged: false, hasUnstaged: true }),
				fileNode('loose.ts', { staged: false, hasUnstaged: true, changeKind: 'untracked' }),
			]),
		);
		mockedApi.gitCommitIndex.mockResolvedValue({ success: true, output: 'commit abc123' });
		mockedApi.gitStagePaths.mockResolvedValue({ success: true });
		mockedApi.generateCommitMessage.mockResolvedValue({ message: 'test: commit' });
	});

	it('retains its project state and starts no work while project identity resolves', async () => {
		const controller = makeController();
		await controller.setProjectState({
			kind: 'available',
			project: {
				chatId: 'chat1',
				projectPath: '/project',
				effectiveProjectKey: '/canonical/project',
			},
		});
		await controller.setPresentationVisible(true);
		controller.message = 'Retained message';
		const treeReads = mockedApi.getGitWorkbenchSnapshot.mock.calls.length;

		await controller.setProjectState({
			kind: 'resolving',
			context: { chatId: 'draft', projectPath: '/project', effectiveProjectKey: null },
		});
		await controller.refreshTree();
		controller.togglePath('unstaged.ts', true);

		expect(controller.projectIdentityPending).toBe(true);
		expect(controller.projectPath).toBe('/project');
		expect(controller.effectiveProjectKey).toBe('/canonical/project');
		expect(controller.message).toBe('Retained message');
		expect(controller.canCommit).toBe(false);
		expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(treeReads);
		expect(mockedApi.gitStagePaths).not.toHaveBeenCalled();

		await controller.setProjectState({
			kind: 'available',
			project: {
				chatId: 'chat2',
				projectPath: '/project',
				effectiveProjectKey: '/canonical/project',
			},
		});
		expect(controller.projectIdentityPending).toBe(false);
		expect(controller.message).toBe('Retained message');
		expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(treeReads);
	});

	it('initializes checked state from staged files only', async () => {
		const controller = makeController();

		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		expect(controller.intentFor('staged.ts')?.desiredSelected).toBe(true);
		expect(controller.intentFor('unstaged.ts')?.desiredSelected).toBe(false);
		expect(controller.intentFor('loose.ts')?.desiredSelected).toBe(false);
		expect(controller.selectedFileCount).toBe(1);
	});

	it('shows tree loading immediately while opening', async () => {
		const summary = deferred<void>();
		const tree = deferred<GitWorkbenchSnapshotReady>();
		mockedApi.getGitWorkbenchSnapshot.mockReturnValueOnce(tree.promise);
		const controller = makeController({
			refreshSummary: vi.fn().mockReturnValue(summary.promise),
		});

		await controller.setContext('/project', '/project');
		const openPromise = controller.setPresentationVisible(true);

		expect(controller.isPresentationVisible).toBe(true);
		expect(controller.isLoadingTree).toBe(true);
		expect(mockedApi.getGitWorkbenchSnapshot).not.toHaveBeenCalled();

		summary.resolve(undefined);
		await vi.waitFor(() => {
			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledOnce();
		});
		expect(controller.isLoadingTree).toBe(true);

		tree.resolve(snapshot([fileNode('staged.ts', { staged: true, hasUnstaged: false })]));
		await openPromise;

		expect(controller.isLoadingTree).toBe(false);
	});

	it('waits for queued staging before committing', async () => {
		const stage = deferred<{ success: boolean }>();
		mockedApi.gitStagePaths.mockReturnValueOnce(stage.promise);
		mockedApi.getGitWorkbenchSnapshot
			.mockResolvedValueOnce(
				snapshot([
					fileNode('staged.ts', { staged: true, hasUnstaged: false }),
					fileNode('unstaged.ts', { staged: false, hasUnstaged: true }),
				]),
			)
			.mockResolvedValue(
				snapshot([
					fileNode('staged.ts', { staged: true, hasUnstaged: false }),
					fileNode('unstaged.ts', { staged: true, hasUnstaged: false }),
				]),
			);
		const controller = makeController();
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		controller.togglePath('unstaged.ts', true);
		controller.message = 'test: commit';
		const commitPromise = controller.commit();

		expect(mockedApi.gitStagePaths).toHaveBeenCalledWith('/project', ['unstaged.ts'], 'stage');
		expect(mockedApi.gitCommitIndex).not.toHaveBeenCalled();

		stage.resolve({ success: true });
		await commitPromise;

		expect(mockedApi.gitCommitIndex).toHaveBeenCalledWith('/project', 'test: commit');
		expect(controller.isPresentationVisible).toBe(true);
	});

	it('generates a commit message from the currently staged files', async () => {
		mockedApi.generateCommitMessage.mockResolvedValue({
			message: 'src/app: feat: generated',
			directoryPrefix: 'src/app',
		});
		const controller = makeController();
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		await controller.generateMessage();

		expect(mockedApi.generateCommitMessage).toHaveBeenCalledWith('/project', ['staged.ts']);
		expect(controller.message).toBe('src/app: feat: generated');
		expect(controller.lastError).toBeNull();
	});

	it('does not publish a generated message into a newly selected project', async () => {
		const generated = deferred<{ message: string }>();
		mockedApi.generateCommitMessage.mockReturnValueOnce(generated.promise);
		const controller = makeController();
		await controller.setContext('/project-a', '/project-a');
		await controller.setPresentationVisible(true);

		const generation = controller.generateMessage();
		await vi.waitFor(() => {
			expect(mockedApi.generateCommitMessage).toHaveBeenCalledWith('/project-a', ['staged.ts']);
		});
		await controller.setContext('/project-b', '/project-b');
		generated.resolve({ message: 'message for project A' });
		await generation;

		expect(controller.effectiveProjectKey).toBe('/project-b');
		expect(controller.message).toBe('');
		expect(controller.isGeneratingMessage).toBe(false);
	});

	it('cancels a pre-accept commit when queued staging retargets', async () => {
		const stage = deferred<{ success: boolean }>();
		mockedApi.gitStagePaths.mockReturnValueOnce(stage.promise);
		const controller = makeController();
		await controller.setContext('/project-a', '/project-a');
		await controller.setPresentationVisible(true);
		controller.togglePath('unstaged.ts', true);
		controller.message = 'project A commit';
		const commit = controller.commit();

		await controller.setContext('/project-b', '/project-b');
		stage.resolve({ success: true });
		await expect(commit).resolves.toBe(false);
		expect(mockedApi.gitCommitIndex).not.toHaveBeenCalled();
		expect(controller.effectiveProjectKey).toBe('/project-b');
	});

	it('keeps the visible surface open and refreshes its Git state after a successful commit', async () => {
		const refreshSummary = vi.fn().mockResolvedValue(undefined);
		mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(
			snapshot([fileNode('staged.ts', { staged: true, hasUnstaged: false })]),
		);
		const controller = makeController({ refreshSummary });
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);
		controller.message = 'test: commit';
		mockedApi.getGitWorkbenchSnapshot.mockClear();
		mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(snapshot([]));
		refreshSummary.mockClear();

		await expect(controller.commit()).resolves.toBe(true);

		expect(controller.isPresentationVisible).toBe(true);
		expect(mockedApi.gitCommitIndex).toHaveBeenCalledWith('/project', 'test: commit');
		expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledOnce();
		expect(controller.tree).toEqual([]);
		expect(refreshSummary).toHaveBeenCalledOnce();
	});

	it('reports a post-commit refresh failure without reclassifying the commit', async () => {
		const refreshSummary = vi.fn().mockResolvedValue(undefined);
		mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(
			snapshot([fileNode('staged.ts', { staged: true, hasUnstaged: false })]),
		);
		const controller = makeController({ refreshSummary });
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);
		controller.message = 'test: commit';
		mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(snapshot([]));
		refreshSummary.mockRejectedValueOnce(new Error('summary unavailable'));

		await expect(controller.commit()).resolves.toBe(true);

		expect(controller.tree).toEqual([]);
		expect(controller.lastError).toContain('summary unavailable');
	});

	it('keeps the controller open when staging fails', async () => {
		mockedApi.gitStagePaths.mockRejectedValueOnce(new Error('index locked'));
		const controller = makeController();
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		controller.togglePath('unstaged.ts', true);
		const queueReady = await controller.waitForQueue();

		expect(queueReady).toBe(false);
		expect(controller.intentFor('unstaged.ts')?.desiredSelected).toBe(false);
		expect(controller.intentFor('unstaged.ts')?.error).toContain('index locked');
		expect(controller.treeErrorMessage).toContain('index locked');
		controller.message = 'test: commit';
		await expect(controller.commit()).resolves.toBe(false);
		expect(controller.isPresentationVisible).toBe(true);
		expect(mockedApi.gitCommitIndex).not.toHaveBeenCalled();
	});

	it('settles staging before the silent refresh finishes', async () => {
		const refresh = deferred<GitWorkbenchSnapshotReady>();
		mockedApi.getGitWorkbenchSnapshot
			.mockResolvedValueOnce(
				snapshot([fileNode('unstaged.ts', { staged: false, hasUnstaged: true })]),
			)
			.mockReturnValueOnce(refresh.promise);
		const controller = makeController();
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		controller.togglePath('unstaged.ts', true);
		await vi.waitFor(() => {
			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(2);
		});

		expect(controller.isLoadingTree).toBe(false);
		expect(controller.isRefreshingTree).toBe(true);
		expect(controller.tree).toHaveLength(1);
		expect(controller.intentFor('unstaged.ts')?.actualSelected).toBe(true);
		await expect(controller.waitForQueue()).resolves.toBe(true);
		expect(controller.isRefreshingTree).toBe(true);

		refresh.resolve(snapshot([fileNode('unstaged.ts', { staged: true, hasUnstaged: false })]));
		await vi.waitFor(() => {
			expect(controller.isRefreshingTree).toBe(false);
		});
	});

	it('generates after staging without waiting for the silent refresh', async () => {
		const stage = deferred<{ success: boolean }>();
		const refresh = deferred<GitWorkbenchSnapshotReady>();
		mockedApi.gitStagePaths.mockReturnValueOnce(stage.promise);
		mockedApi.getGitWorkbenchSnapshot
			.mockResolvedValueOnce(
				snapshot([fileNode('unstaged.ts', { staged: false, hasUnstaged: true })]),
			)
			.mockReturnValueOnce(refresh.promise);
		const controller = makeController();
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		controller.togglePath('unstaged.ts', true);
		const generatePromise = controller.generateMessage();
		expect(mockedApi.generateCommitMessage).not.toHaveBeenCalled();

		stage.resolve({ success: true });
		await vi.waitFor(() => {
			expect(mockedApi.generateCommitMessage).toHaveBeenCalledWith('/project', ['unstaged.ts']);
		});
		expect(controller.isRefreshingTree).toBe(true);

		refresh.resolve(snapshot([fileNode('unstaged.ts', { staged: true, hasUnstaged: false })]));
		await generatePromise;
		await vi.waitFor(() => {
			expect(controller.isRefreshingTree).toBe(false);
		});
	});

	it('stages descendant files in one batch when a directory is selected', async () => {
		mockedApi.getGitWorkbenchSnapshot
			.mockResolvedValueOnce(
				snapshot([
					directoryNode('src', [
						fileNode('src/a.ts', { staged: false, hasUnstaged: true }),
						fileNode('src/b.ts', { staged: false, hasUnstaged: true }),
					]),
				]),
			)
			.mockResolvedValueOnce(
				snapshot([
					directoryNode('src', [
						fileNode('src/a.ts', { staged: true, hasUnstaged: false }),
						fileNode('src/b.ts', { staged: true, hasUnstaged: false }),
					]),
				]),
			);
		const controller = makeController();
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		expect(controller.directorySelection('src')).toMatchObject({
			checked: false,
			mixed: false,
			fileCount: 2,
		});

		controller.toggleDirectory('src', true);
		expect(await controller.waitForQueue()).toBe(true);

		expect(mockedApi.gitStagePaths).toHaveBeenCalledOnce();
		expect(mockedApi.gitStagePaths).toHaveBeenCalledWith(
			'/project',
			['src/a.ts', 'src/b.ts'],
			'stage',
		);
		expect(controller.directorySelection('src')).toMatchObject({
			checked: true,
			mixed: false,
			fileCount: 2,
		});
	});

	it('unstages staged descendant files in one batch when a directory is cleared', async () => {
		mockedApi.getGitWorkbenchSnapshot
			.mockResolvedValueOnce(
				snapshot([
					directoryNode('src', [
						fileNode('src/a.ts', { staged: true, hasUnstaged: false }),
						fileNode('src/b.ts', { staged: true, hasUnstaged: false }),
					]),
				]),
			)
			.mockResolvedValueOnce(
				snapshot([
					directoryNode('src', [
						fileNode('src/a.ts', { staged: false, hasUnstaged: true }),
						fileNode('src/b.ts', { staged: false, hasUnstaged: true }),
					]),
				]),
			);
		const controller = makeController();
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		controller.toggleDirectory('src', false);
		expect(await controller.waitForQueue()).toBe(true);

		expect(mockedApi.gitStagePaths).toHaveBeenCalledOnce();
		expect(mockedApi.gitStagePaths).toHaveBeenCalledWith(
			'/project',
			['src/a.ts', 'src/b.ts'],
			'unstage',
		);
		expect(controller.directorySelection('src')).toMatchObject({
			checked: false,
			mixed: false,
			fileCount: 2,
		});
	});

	it('does not restage already staged mixed files during directory staging', async () => {
		mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(
			snapshot([
				directoryNode('src', [
					fileNode('src/unstaged.ts', { staged: false, hasUnstaged: true }),
					fileNode('src/mixed.ts', { staged: true, hasUnstaged: true }),
				]),
			]),
		);
		const controller = makeController();
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		controller.toggleDirectory('src', true);
		expect(await controller.waitForQueue()).toBe(true);

		expect(mockedApi.gitStagePaths).toHaveBeenCalledOnce();
		expect(mockedApi.gitStagePaths).toHaveBeenCalledWith('/project', ['src/unstaged.ts'], 'stage');
	});

	it('keeps the existing tree visible during manual refresh', async () => {
		const refresh = deferred<GitWorkbenchSnapshotReady>();
		mockedApi.getGitWorkbenchSnapshot
			.mockResolvedValueOnce(
				snapshot([fileNode('staged.ts', { staged: true, hasUnstaged: false })]),
			)
			.mockReturnValueOnce(refresh.promise);
		const controller = makeController();
		await controller.setContext('/project', '/project');
		await controller.setPresentationVisible(true);

		const refreshPromise = controller.refreshTree();
		await vi.waitFor(() => {
			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(2);
		});

		expect(controller.isLoadingTree).toBe(false);
		expect(controller.isRefreshingTree).toBe(true);
		expect(controller.tree).toHaveLength(1);

		refresh.resolve(snapshot([fileNode('staged.ts', { staged: true, hasUnstaged: false })]));
		await refreshPromise;
		expect(controller.isRefreshingTree).toBe(false);
	});
});
