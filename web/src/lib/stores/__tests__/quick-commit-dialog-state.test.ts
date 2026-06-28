import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	QuickCommitDialogState,
	type QuickCommitDialogDeps,
} from '../git/quick-commit-dialog-state.svelte';
import type {
	GitChangesTreeResult,
	GitTreeNode,
	GitWorkbenchSnapshotReady,
} from '$lib/api/git.js';

vi.mock('$lib/api/git.js', () => ({
	getGitWorkbenchSnapshot: vi.fn(),
	gitStageFile: vi.fn(),
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

function fileNode(
	path: string,
	overrides: Partial<GitTreeNode> = {},
): GitTreeNode {
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

function makeDialog(overrides: Partial<QuickCommitDialogDeps> = {}) {
	return new QuickCommitDialogState({
		refreshSummary: vi.fn().mockResolvedValue(undefined),
		markProjectChanged: vi.fn(),
		...overrides,
	});
}

describe('QuickCommitDialogState', () => {
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
		mockedApi.gitStageFile.mockResolvedValue({ success: true });
		mockedApi.generateCommitMessage.mockResolvedValue({ message: 'test: commit' });
	});

	it('initializes checked state from staged files only', async () => {
		const dialog = makeDialog();

		await dialog.open('/project');

		expect(dialog.intentFor('staged.ts')?.desiredSelected).toBe(true);
		expect(dialog.intentFor('unstaged.ts')?.desiredSelected).toBe(false);
		expect(dialog.intentFor('loose.ts')?.desiredSelected).toBe(false);
		expect(dialog.selectedFileCount).toBe(1);
	});

	it('shows tree loading immediately while opening', async () => {
		const summary = deferred<void>();
		const tree = deferred<GitWorkbenchSnapshotReady>();
		mockedApi.getGitWorkbenchSnapshot.mockReturnValueOnce(tree.promise);
		const dialog = makeDialog({
			refreshSummary: vi.fn().mockReturnValue(summary.promise),
		});

		const openPromise = dialog.open('/project');

		expect(dialog.isOpen).toBe(true);
		expect(dialog.isLoadingTree).toBe(true);
		expect(mockedApi.getGitWorkbenchSnapshot).not.toHaveBeenCalled();

		summary.resolve(undefined);
		await vi.waitFor(() => {
			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledOnce();
		});
		expect(dialog.isLoadingTree).toBe(true);

		tree.resolve(snapshot([fileNode('staged.ts', { staged: true, hasUnstaged: false })]));
		await openPromise;

		expect(dialog.isLoadingTree).toBe(false);
	});

	it('waits for queued staging before committing', async () => {
		const stage = deferred<{ success: boolean }>();
		mockedApi.gitStageFile.mockReturnValueOnce(stage.promise);
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
		const dialog = makeDialog();
		await dialog.open('/project');

		dialog.togglePath('unstaged.ts', true);
		dialog.message = 'test: commit';
		const commitPromise = dialog.commit();

		expect(mockedApi.gitStageFile).toHaveBeenCalledWith('/project', 'unstaged.ts', 'stage');
		expect(mockedApi.gitCommitIndex).not.toHaveBeenCalled();

		stage.resolve({ success: true });
		await commitPromise;

		expect(mockedApi.gitCommitIndex).toHaveBeenCalledWith('/project', 'test: commit');
		expect(dialog.isOpen).toBe(false);
	});

	it('generates a commit message from the currently staged files', async () => {
		mockedApi.generateCommitMessage.mockResolvedValue({
			message: 'src/app: feat: generated',
			directoryPrefix: 'src/app',
		});
		const dialog = makeDialog();
		await dialog.open('/project');

		await dialog.generateMessage();

		expect(mockedApi.generateCommitMessage).toHaveBeenCalledWith('/project', ['staged.ts']);
		expect(dialog.message).toBe('src/app: feat: generated');
		expect(dialog.lastError).toBeNull();
	});

	it('keeps the dialog open when staging fails', async () => {
		mockedApi.gitStageFile.mockRejectedValueOnce(new Error('index locked'));
		const dialog = makeDialog();
		await dialog.open('/project');

		dialog.togglePath('unstaged.ts', true);
		const queueReady = await dialog.waitForQueue();

		expect(queueReady).toBe(false);
		expect(dialog.intentFor('unstaged.ts')?.desiredSelected).toBe(false);
		expect(dialog.intentFor('unstaged.ts')?.error).toContain('index locked');
		expect(dialog.treeErrorMessage).toContain('index locked');
		dialog.message = 'test: commit';
		await expect(dialog.commit()).resolves.toBe(false);
		expect(dialog.isOpen).toBe(true);
		expect(mockedApi.gitCommitIndex).not.toHaveBeenCalled();
	});

	it('refreshes the tree silently after staging without clearing the visible files', async () => {
		const refresh = deferred<GitWorkbenchSnapshotReady>();
		mockedApi.getGitWorkbenchSnapshot
			.mockResolvedValueOnce(
				snapshot([fileNode('unstaged.ts', { staged: false, hasUnstaged: true })]),
			)
			.mockReturnValueOnce(refresh.promise);
		const dialog = makeDialog();
		await dialog.open('/project');

		dialog.togglePath('unstaged.ts', true);
		await vi.waitFor(() => {
			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(2);
		});

		expect(dialog.isLoadingTree).toBe(false);
		expect(dialog.isRefreshingTree).toBe(true);
		expect(dialog.tree).toHaveLength(1);
		expect(dialog.intentFor('unstaged.ts')?.actualSelected).toBe(true);

		refresh.resolve(snapshot([fileNode('unstaged.ts', { staged: true, hasUnstaged: false })]));
		expect(await dialog.waitForQueue()).toBe(true);
		expect(dialog.isRefreshingTree).toBe(false);
	});

	it('queues descendant file operations when a directory is selected', async () => {
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
		const dialog = makeDialog();
		await dialog.open('/project');

		expect(dialog.directorySelection('src')).toMatchObject({
			checked: false,
			mixed: false,
			fileCount: 2,
		});

		dialog.toggleDirectory('src', true);
		expect(await dialog.waitForQueue()).toBe(true);

		expect(mockedApi.gitStageFile).toHaveBeenNthCalledWith(1, '/project', 'src/a.ts', 'stage');
		expect(mockedApi.gitStageFile).toHaveBeenNthCalledWith(2, '/project', 'src/b.ts', 'stage');
		expect(dialog.directorySelection('src')).toMatchObject({
			checked: true,
			mixed: false,
			fileCount: 2,
		});
	});

	it('keeps the existing tree visible during manual refresh', async () => {
		const refresh = deferred<GitWorkbenchSnapshotReady>();
		mockedApi.getGitWorkbenchSnapshot
			.mockResolvedValueOnce(snapshot([fileNode('staged.ts', { staged: true, hasUnstaged: false })]))
			.mockReturnValueOnce(refresh.promise);
		const dialog = makeDialog();
		await dialog.open('/project');

		const refreshPromise = dialog.refreshTree();
		await vi.waitFor(() => {
			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(2);
		});

		expect(dialog.isLoadingTree).toBe(false);
		expect(dialog.isRefreshingTree).toBe(true);
		expect(dialog.tree).toHaveLength(1);

		refresh.resolve(snapshot([fileNode('staged.ts', { staged: true, hasUnstaged: false })]));
		await refreshPromise;
		expect(dialog.isRefreshingTree).toBe(false);
	});
});
