import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import { getGitRefs, gitCheckoutRef, gitCreateBranch } from '$lib/api/git.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence.js';

vi.mock('$lib/api/git.js', () => ({
	getGitRefs: vi.fn(),
	gitCheckoutRef: vi.fn(),
	gitCreateBranch: vi.fn(),
}));

const NAME_ASC = { key: 'name', direction: 'asc' } as const;
const UPDATED_ASC = { key: 'updated', direction: 'asc' } as const;
const UPDATED_DESC = { key: 'updated', direction: 'desc' } as const;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function expectRefRequest(
	projectPath: string,
	query: string,
	sort: { key: 'name' | 'updated'; direction: 'asc' | 'desc' },
): void {
	expect(getGitRefs).toHaveBeenLastCalledWith(projectPath, {
		query,
		limit: 200,
		sort,
		signal: expect.any(AbortSignal),
	});
}

function requestSignal(index: number): AbortSignal {
	const options = vi.mocked(getGitRefs).mock.calls[index]?.[1];
	if (!options?.signal) throw new Error(`Missing request signal at call ${index}`);
	return options.signal;
}

describe('GitBranchSelectorState', () => {
	let branchSelector: GitBranchSelectorState;

	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
		vi.mocked(getGitRefs).mockResolvedValue({
			refs: [
				{
					name: 'main',
					ref: 'refs/heads/main',
					kind: 'local-branch',
					updatedAt: null,
					isCurrent: true,
				},
				{
					name: 'feature',
					ref: 'refs/heads/feature',
					kind: 'local-branch',
					updatedAt: null,
				},
				{
					name: 'origin/main',
					ref: 'refs/remotes/origin/main',
					kind: 'remote-branch',
					updatedAt: null,
				},
			],
		});
		branchSelector = new GitBranchSelectorState();
	});

	it('persists sort selections globally and restores the latest direction', async () => {
		await branchSelector.toggleBranchSort('/project', 'updated');

		expect(localStorage.length).toBe(1);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.gitBranchSort) ?? '')).toEqual(
			UPDATED_DESC,
		);
		expect(new GitBranchSelectorState().branchSort).toEqual(UPDATED_DESC);

		await branchSelector.toggleBranchSort('/project', 'updated');

		expect(new GitBranchSelectorState().branchSort).toEqual(UPDATED_ASC);
	});

	it.each([
		['malformed JSON', '{broken'],
		['non-object JSON', '[]'],
		['partial sort', JSON.stringify({ key: 'updated' })],
		['unknown key', JSON.stringify({ key: 'recent', direction: 'desc' })],
		['unknown direction', JSON.stringify({ key: 'updated', direction: 'newest' })],
	])('falls back to Name ascending for %s in persisted sort', (_name, value) => {
		localStorage.setItem(LOCAL_STORAGE_KEYS.gitBranchSort, value);

		expect(new GitBranchSelectorState().branchSort).toEqual(NAME_ASC);
	});

	it('reuses branch data for the same project and resets on project changes', () => {
		branchSelector.setProject('/project-a', 'main');
		branchSelector.branches = ['main'];
		branchSelector.showBranchDropdown = true;

		branchSelector.setProject('/project-a', 'feature');

		expect(branchSelector.currentBranch).toBe('feature');
		expect(branchSelector.branches).toEqual(['main']);
		expect(branchSelector.showBranchDropdown).toBe(true);

		branchSelector.setProject('/project-b', 'main');

		expect(branchSelector.currentProjectPath).toBe('/project-b');
		expect(branchSelector.currentBranch).toBe('main');
		expect(branchSelector.branches).toEqual([]);
		expect(branchSelector.showBranchDropdown).toBe(false);
	});

	it('keeps sort preference across project resets', async () => {
		expect(branchSelector.branchSort).toEqual(NAME_ASC);

		await branchSelector.toggleBranchSort('/project-a', 'updated', 'release');
		expect(branchSelector.branchSort).toEqual(UPDATED_DESC);
		expectRefRequest('/project-a', 'release', UPDATED_DESC);

		branchSelector.resetForProject('/project-b', 'main');

		expect(branchSelector.branchSort).toEqual(UPDATED_DESC);
	});

	it('toggles active sort direction and gives each new key its preferred direction', async () => {
		await branchSelector.toggleBranchSort('/project', 'updated', 'feat');
		expect(branchSelector.branchSort).toEqual(UPDATED_DESC);
		expectRefRequest('/project', 'feat', UPDATED_DESC);

		await branchSelector.toggleBranchSort('/project', 'updated', 'feat');
		expect(branchSelector.branchSort).toEqual(UPDATED_ASC);
		expectRefRequest('/project', 'feat', UPDATED_ASC);

		await branchSelector.toggleBranchSort('/project', 'name', 'feat');
		expect(branchSelector.branchSort).toEqual(NAME_ASC);
		expectRefRequest('/project', 'feat', NAME_ASC);

		await branchSelector.toggleBranchSort('/project', 'name', 'feat');
		expect(branchSelector.branchSort).toEqual({ key: 'name', direction: 'desc' });
		expectRefRequest('/project', 'feat', { key: 'name', direction: 'desc' });
	});

	it('always reloads the branch dropdown using its current sort', async () => {
		branchSelector.refs = [
			{
				name: 'cached',
				ref: 'refs/heads/cached',
				kind: 'local-branch',
				updatedAt: null,
			},
		];
		branchSelector.branchSort = { ...UPDATED_DESC };

		await branchSelector.openBranchDropdown('/project');

		expect(branchSelector.showBranchDropdown).toBe(true);
		expectRefRequest('/project', '', UPDATED_DESC);
	});

	it('keeps generic ref loads on Name ascending without changing branch sort', async () => {
		branchSelector.branchSort = { ...UPDATED_DESC };

		await branchSelector.fetchRefs('/project', 'origin');

		expectRefRequest('/project', 'origin', NAME_ASC);
		expect(branchSelector.branchSort).toEqual(UPDATED_DESC);
	});

	it('aborts superseded branch loads and publishes only the latest response', async () => {
		const stale = deferred<Awaited<ReturnType<typeof getGitRefs>>>();
		const current = deferred<Awaited<ReturnType<typeof getGitRefs>>>();
		vi.mocked(getGitRefs).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);

		const staleLoad = branchSelector.searchBranchRefs('/project', 'old');
		const staleSignal = requestSignal(0);
		const currentLoad = branchSelector.toggleBranchSort('/project', 'updated', 'new');

		expect(staleSignal.aborted).toBe(true);
		expect(requestSignal(1).aborted).toBe(false);
		current.resolve({
			refs: [
				{
					name: 'current',
					ref: 'refs/heads/current',
					kind: 'local-branch',
					updatedAt: null,
				},
			],
		});
		await currentLoad;
		stale.resolve({
			refs: [
				{
					name: 'stale',
					ref: 'refs/heads/stale',
					kind: 'local-branch',
					updatedAt: null,
				},
			],
		});
		await staleLoad;

		expect(branchSelector.refs.map((ref) => ref.name)).toEqual(['current']);
		expect(branchSelector.isLoadingBranches).toBe(false);
		expect(branchSelector.lastError).toBeNull();
	});

	it.each([
		['close', (selector: GitBranchSelectorState) => selector.closeBranchDropdown()],
		['reset', (selector: GitBranchSelectorState) => selector.resetForProject('/other', 'develop')],
		['destroy', (selector: GitBranchSelectorState) => selector.destroy()],
	] as const)('silently aborts a branch load on %s', async (_name, cancel) => {
		const surfaceError = vi.fn();
		branchSelector = new GitBranchSelectorState({ surfaceError });
		const pending = deferred<Awaited<ReturnType<typeof getGitRefs>>>();
		vi.mocked(getGitRefs).mockReturnValueOnce(pending.promise);
		const load = branchSelector.searchBranchRefs('/project');
		const signal = requestSignal(0);

		cancel(branchSelector);
		pending.reject(new DOMException('aborted', 'AbortError'));
		await load;

		expect(signal.aborted).toBe(true);
		expect(branchSelector.isLoadingBranches).toBe(false);
		expect(branchSelector.lastError).toBeNull();
		expect(surfaceError).not.toHaveBeenCalled();
	});

	it('uses independent request controllers for branch and new-branch refs', async () => {
		const branchRequest = deferred<Awaited<ReturnType<typeof getGitRefs>>>();
		const newBranchRequest = deferred<Awaited<ReturnType<typeof getGitRefs>>>();
		const nextNewBranchRequest = deferred<Awaited<ReturnType<typeof getGitRefs>>>();
		vi.mocked(getGitRefs)
			.mockReturnValueOnce(branchRequest.promise)
			.mockReturnValueOnce(newBranchRequest.promise)
			.mockReturnValueOnce(nextNewBranchRequest.promise);
		branchSelector.newBranchProjectPath = '/project/worktree';

		const branchLoad = branchSelector.searchBranchRefs('/project', 'branch');
		const newBranchLoad = branchSelector.searchNewBranchRefs('base');
		const branchSignal = requestSignal(0);
		const staleNewBranchSignal = requestSignal(1);
		const currentNewBranchLoad = branchSelector.searchNewBranchRefs('new-base');

		expect(branchSignal.aborted).toBe(false);
		expect(staleNewBranchSignal.aborted).toBe(true);
		expect(requestSignal(2).aborted).toBe(false);
		expectRefRequest('/project/worktree', 'new-base', NAME_ASC);
		nextNewBranchRequest.resolve({ refs: [] });
		await currentNewBranchLoad;
		newBranchRequest.reject(new DOMException('aborted', 'AbortError'));
		await newBranchLoad;
		branchSelector.closeBranchDropdown();
		branchRequest.reject(new DOMException('aborted', 'AbortError'));
		await branchLoad;

		expect(branchSelector.lastError).toBeNull();
	});

	it.each([
		['close', (selector: GitBranchSelectorState) => selector.closeNewBranchDialog()],
		['reset', (selector: GitBranchSelectorState) => selector.resetForProject('/other', 'develop')],
		['destroy', (selector: GitBranchSelectorState) => selector.destroy()],
	] as const)('silently aborts a new-branch ref load on %s', async (_name, cancel) => {
		const surfaceError = vi.fn();
		branchSelector = new GitBranchSelectorState({ surfaceError });
		branchSelector.newBranchProjectPath = '/project';
		const pending = deferred<Awaited<ReturnType<typeof getGitRefs>>>();
		vi.mocked(getGitRefs).mockReturnValueOnce(pending.promise);
		const load = branchSelector.searchNewBranchRefs('base');
		const signal = requestSignal(0);

		cancel(branchSelector);
		pending.reject(new DOMException('aborted', 'AbortError'));
		await load;

		expect(signal.aborted).toBe(true);
		expect(branchSelector.isLoadingNewBranchRefs).toBe(false);
		expect(branchSelector.lastError).toBeNull();
		expect(surfaceError).not.toHaveBeenCalled();
	});

	it('switches branches, refreshes branches, and notifies after mutation', async () => {
		const onMutation = vi.fn();
		branchSelector = new GitBranchSelectorState({ onMutation });
		branchSelector.setProject('/project', 'main', '/project');
		branchSelector.branchSort = { ...UPDATED_DESC };
		branchSelector.showBranchDropdown = true;
		branchSelector.refs = [
			{
				name: 'feature',
				ref: 'refs/heads/feature',
				kind: 'local-branch',
				updatedAt: null,
			},
		];
		vi.mocked(gitCheckoutRef).mockResolvedValue({ success: true });
		vi.mocked(getGitRefs).mockResolvedValueOnce({
			refs: [
				{
					name: 'feature',
					ref: 'refs/heads/feature',
					kind: 'local-branch',
					updatedAt: null,
					isCurrent: true,
				},
			],
		});

		const ok = await branchSelector.switchBranch(
			'/project',
			'feature',
			undefined,
			'singleton:git',
			'/project',
		);

		expect(ok).toBe(true);
		expect(gitCheckoutRef).toHaveBeenCalledWith('/project', 'refs/heads/feature', 'local-branch');
		expectRefRequest('/project', '', UPDATED_DESC);
		expect(onMutation).toHaveBeenCalledWith('/project', 'switch', '/project');
		expect(branchSelector.currentBranch).toBe('feature');
		expect(branchSelector.showBranchDropdown).toBe(false);
	});

	it('updates the current branch only from an unfiltered ref response', async () => {
		branchSelector.setProject('/project', 'old', '/project');
		await branchSelector.fetchRefs('/project');
		expect(branchSelector.currentBranch).toBe('main');

		vi.mocked(getGitRefs).mockResolvedValueOnce({
			refs: [
				{
					name: 'feature',
					ref: 'refs/heads/feature',
					kind: 'local-branch',
					updatedAt: null,
					isCurrent: true,
				},
			],
		});
		await branchSelector.fetchRefs('/project', 'feat');
		expect(branchSelector.currentBranch).toBe('main');
	});

	it('checks out remote refs using their full ref value', async () => {
		branchSelector.setProject('/project', 'main', '/project');
		branchSelector.refs = [
			{
				name: 'origin/main',
				ref: 'refs/remotes/origin/main',
				kind: 'remote-branch',
				updatedAt: null,
			},
		];
		vi.mocked(gitCheckoutRef).mockResolvedValue({ success: true });
		vi.mocked(getGitRefs).mockResolvedValueOnce({
			refs: [
				{
					name: 'origin/main',
					ref: 'refs/remotes/origin/main',
					kind: 'remote-branch',
					updatedAt: null,
				},
			],
		});

		const ok = await branchSelector.switchBranch(
			'/project',
			'origin/main',
			undefined,
			'singleton:commit',
			'/project',
		);

		expect(ok).toBe(true);
		expect(gitCheckoutRef).toHaveBeenCalledWith(
			'/project',
			'refs/remotes/origin/main',
			'remote-branch',
		);
		expect(branchSelector.currentBranch).toBe('origin/main');
	});

	it('creates trimmed branches and clears modal state after success', async () => {
		const onMutation = vi.fn();
		branchSelector = new GitBranchSelectorState({ onMutation });
		branchSelector.setProject('/project', 'main');
		branchSelector.branchSort = { ...UPDATED_DESC };
		branchSelector.openNewBranchDialog('/project', 'singleton:git', '/project');
		branchSelector.newBranchName = '  feature/new-ui  ';
		branchSelector.newBranchBaseRef = 'refs/remotes/origin/main';
		vi.mocked(gitCreateBranch).mockResolvedValue({ success: true });
		vi.mocked(getGitRefs).mockResolvedValueOnce({
			refs: [
				{
					name: 'feature/new-ui',
					ref: 'refs/heads/feature/new-ui',
					kind: 'local-branch',
					updatedAt: null,
					isCurrent: true,
				},
			],
		});

		const ok = await branchSelector.createBranch();

		expect(ok).toBe(true);
		expect(gitCreateBranch).toHaveBeenCalledWith('/project', 'feature/new-ui', {
			baseRef: 'refs/remotes/origin/main',
		});
		expectRefRequest('/project', '', UPDATED_DESC);
		expect(onMutation).toHaveBeenCalledWith('/project', 'create', '/project');
		expect(branchSelector.currentBranch).toBe('feature/new-ui');
		expect(branchSelector.showNewBranchModal).toBe(false);
		expect(branchSelector.newBranchName).toBe('');
		expect(branchSelector.newBranchBaseRef).toBe('');
	});

	it('lets an in-flight create finish without publishing into a newly selected target', async () => {
		let resolveCreate!: (value: { success: boolean }) => void;
		const create = new Promise<{ success: boolean }>((resolve) => {
			resolveCreate = resolve;
		});
		const runMutation = vi.fn(
			async (
				_surfaceId: string,
				_projectPath: string,
				_effectiveProjectKey: string,
				execute: () => Promise<{ success: boolean; error?: string }>,
			) => execute(),
		);
		branchSelector = new GitBranchSelectorState({ runMutation });
		branchSelector.setProject('/project', 'main', '/canonical/project');
		branchSelector.openNewBranchDialog(
			'/project/worktrees/feature',
			'singleton:git',
			'/canonical/project',
		);
		await branchSelector.searchNewBranchRefs('origin');
		branchSelector.newBranchName = 'captured-target';
		vi.mocked(gitCreateBranch).mockReturnValueOnce(create);
		const pendingCreate = branchSelector.createBranch();
		branchSelector.resetForProject('/other', 'develop', '/canonical/other');
		resolveCreate({ success: true });
		await expect(pendingCreate).resolves.toBe(true);

		expect(getGitRefs).toHaveBeenCalledWith('/project/worktrees/feature', {
			query: 'origin',
			limit: 200,
			sort: NAME_ASC,
			signal: expect.any(AbortSignal),
		});
		expect(gitCreateBranch).toHaveBeenCalledWith('/project/worktrees/feature', 'captured-target', {
			baseRef: undefined,
		});
		expect(runMutation).toHaveBeenCalledWith(
			'singleton:git',
			'/project/worktrees/feature',
			'/canonical/project',
			expect.any(Function),
		);
		expect(branchSelector.currentProjectPath).toBe('/other');
		expect(branchSelector.currentBranch).toBe('develop');
		expect(branchSelector.showNewBranchModal).toBe(false);
	});

	it('does not publish a deferred checkout into another worktree in the same chat', async () => {
		let resolveCheckout!: (value: { success: boolean }) => void;
		const checkout = new Promise<{ success: boolean }>((resolve) => {
			resolveCheckout = resolve;
		});
		branchSelector.setProject('/worktree-a', 'main', '/chat');
		vi.mocked(gitCheckoutRef).mockReturnValueOnce(checkout);

		const pending = branchSelector.switchBranch(
			'/worktree-a',
			'feature',
			'local-branch',
			'singleton:git-history',
			'/chat',
		);
		branchSelector.resetForProject('/worktree-b', 'develop', '/chat');
		resolveCheckout({ success: true });

		await expect(pending).resolves.toBe(true);
		expect(branchSelector.currentProjectPath).toBe('/worktree-b');
		expect(branchSelector.currentBranch).toBe('develop');
		expect(getGitRefs).not.toHaveBeenCalledWith('/worktree-a', {
			query: '',
			limit: 200,
			sort: NAME_ASC,
			signal: expect.any(AbortSignal),
		});
	});

	it('uses the invoking effective key after another surface retargets shared branch state', async () => {
		const runMutation = vi.fn(
			async (
				_surfaceId: string,
				_projectPath: string,
				_effectiveProjectKey: string,
				execute: () => Promise<{ success: boolean; error?: string }>,
			) => execute(),
		);
		branchSelector = new GitBranchSelectorState({ runMutation });
		branchSelector.setProject('/project-b', 'main', '/canonical/b');
		vi.mocked(gitCheckoutRef).mockResolvedValue({ success: true });

		await branchSelector.switchBranch(
			'/project-a',
			'feature-a',
			undefined,
			'chat-view:window-main',
			'/canonical/a',
		);

		expect(runMutation).toHaveBeenCalledWith(
			'chat-view:window-main',
			'/project-a',
			'/canonical/a',
			expect.any(Function),
		);
		expect(branchSelector.currentEffectiveProjectKey).toBe('/canonical/b');
		expect(branchSelector.currentBranch).toBe('main');
	});
});
