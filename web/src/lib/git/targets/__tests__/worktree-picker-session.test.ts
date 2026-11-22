import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { getGitWorktrees, gitCreateWorktree } from '$lib/api/git.js';
import { WorktreePickerSession } from '../worktree-picker-session.svelte.js';

vi.mock('$lib/api/git.js', () => ({ getGitWorktrees: vi.fn(), gitCreateWorktree: vi.fn() }));

const target = { executorId: 'remote', projectPath: '/repo ' };
const scope = { executorId: target.executorId, instanceId: 'worker-1' };
const draft = { newBranch: 'fresh-name', worktreePath: '/dest ' };
const receipt = { ...scope, success: true, worktreePath: '/canonical ' };

async function heldCreate() {
	const host = { target, context: 'worker-1' as string | null };
	const select = vi.fn();
	const picker = new WorktreePickerSession({
		target: () => host.target,
		servingContext: () => host.context,
		servingInstanceId: () => host.context,
		select,
	});
	await picker.open();
	const reply = Promise.withResolvers<Awaited<ReturnType<typeof gitCreateWorktree>>>();
	vi.mocked(gitCreateWorktree).mockReturnValueOnce(reply.promise);
	const creation = picker.create(draft);
	expect(gitCreateWorktree).toHaveBeenCalledExactlyOnceWith(target, draft);
	return { picker, reply, creation, host, select };
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(getGitWorktrees).mockResolvedValue({ ...scope, worktrees: [] });
});

it.each([false, true])('does not select a replacement-worker reply while the browser shows the original worker (switched: %s)', async (switched) => {
	const { picker, host, reply, creation, select } = await heldCreate();
	if (switched) {
		host.context = 'worker-2';
		await picker.syncCatalog();
		host.context = 'worker-1';
		await picker.syncCatalog();
	}
	reply.resolve({ ...receipt, instanceId: 'worker-2' });
	await creation;
	expect(select).not.toHaveBeenCalled();
	expect(picker.createResult).toEqual({ createdPath: receipt.worktreePath });
	expect(getGitWorktrees).toHaveBeenCalledTimes(2);
	expect(gitCreateWorktree).toHaveBeenCalledTimes(1);
});

it('rejects a catalog ahead of the browser snapshot and reloads when the snapshot catches up', async () => {
	const row = { name: 'main', path: '/repo', branch: 'main', isCurrent: true, isMain: true, isPathMissing: false, lastModifiedAt: null };
	const catalog = { ...scope, instanceId: 'worker-2', worktrees: [row] };
	vi.mocked(getGitWorktrees).mockResolvedValue(catalog);
	let instance: string | null = scope.instanceId;
	const picker = new WorktreePickerSession({
		target: () => target, servingContext: () => instance, servingInstanceId: () => instance, select: vi.fn(),
	});
	await picker.open();
	expect(picker.worktrees).toEqual([]);
	expect(picker.loadError).toBeTruthy();
	expect(picker.canRefresh).toBe(true);
	await picker.create(draft);
	expect(gitCreateWorktree).not.toHaveBeenCalled();
	vi.mocked(getGitWorktrees).mockRejectedValueOnce(new Error('Read failed'));
	await picker.refresh();
	expect(picker.canUseGit).toBe(false);
	instance = null;
	await picker.syncCatalog();
	expect(picker.loadError).toBeNull();
	instance = catalog.instanceId;
	await picker.syncCatalog();
	expect(picker.worktrees).toEqual([row]);
	expect(picker.canUseGit).toBe(true);
	expect(getGitWorktrees).toHaveBeenCalledTimes(3);
});

it('uses the Local catalog instance before the first executor snapshot arrives', async () => {
	const local = { executorId: 'local', instanceId: 'local-runtime' };
	vi.mocked(getGitWorktrees).mockResolvedValue({ ...local, worktrees: [] });
	vi.mocked(gitCreateWorktree).mockResolvedValue({ ...local, success: true, worktreePath: '/created' });
	const select = vi.fn();
	const picker = new WorktreePickerSession({
		target: () => ({ executorId: local.executorId, projectPath: '/repo' }),
		servingContext: () => 'local', servingInstanceId: () => null, select,
	});
	await picker.open();
	await picker.create(draft);
	expect(select).toHaveBeenCalledExactlyOnceWith('/created');
});

it('replaces a catalog read error with offline status without clearing the mutation result', async () => {
	const { picker, host, reply, creation } = await heldCreate();
	vi.mocked(getGitWorktrees).mockRejectedValueOnce(new Error('Catalog failed'));
	reply.resolve({ ...scope, success: false, error: 'Destination occupied' });
	await creation;
	await vi.waitFor(() => expect(picker.loadError).toBeTruthy());
	host.context = null;
	await picker.syncCatalog();
	expect(picker.loadError).toBeNull();
	expect(picker.createResult).toEqual({ error: 'Destination occupied' });
});

it('retains uncertainty delivered offline through a failed reconnect read and never replays Create', async () => {
	const { picker, host, reply, creation, select } = await heldCreate();
	host.context = null;
	await picker.syncCatalog();
	await picker.create(draft);
	const error = 'Inspect the repository before retrying.';
	reply.reject(new ApiError(503, error, 'GIT_MUTATION_OUTCOME_UNKNOWN'));
	await expect(creation).resolves.toEqual({ target, result: { error } });
	expect(picker.createResult).toEqual({ error });
	expect(picker.isCreating).toBe(false);
	expect(picker.canUseGit).toBe(false);
	expect(getGitWorktrees).toHaveBeenCalledTimes(1);
	host.context = 'worker-1';
	vi.mocked(getGitWorktrees).mockRejectedValueOnce(new Error('Read failed'));
	await picker.syncCatalog();
	expect(getGitWorktrees).toHaveBeenCalledTimes(2);
	expect(picker.loadError).toBeTruthy();
	expect(picker.createResult).toEqual({ error });
	expect(select).not.toHaveBeenCalled();
	expect(gitCreateWorktree).toHaveBeenCalledTimes(1);
});

it.each([null, 'worker-2'])('reports a confirmed path without auto-selecting in serving context %s', async (context) => {
	const { picker, host, reply, creation, select } = await heldCreate();
	host.context = context;
	await picker.syncCatalog();
	reply.resolve(receipt);
	await creation;
	expect(picker.createResult).toEqual({ createdPath: receipt.worktreePath });
	host.context = 'worker-2';
	await picker.syncCatalog();
	expect(picker.isOpen).toBe(true);
	expect(select).not.toHaveBeenCalled();
	expect(getGitWorktrees).toHaveBeenCalledTimes(2);
	expect(gitCreateWorktree).toHaveBeenCalledTimes(1);
});

it('selects a confirmed path when the same worker returns to the original visit', async () => {
	const { picker, host, reply, creation, select } = await heldCreate();
	host.context = null;
	await picker.syncCatalog();
	host.context = 'worker-1';
	await picker.syncCatalog();
	reply.resolve(receipt);
	await creation;
	expect(select).toHaveBeenCalledExactlyOnceWith(receipt.worktreePath);
	expect(picker.isOpen).toBe(false);
	expect(gitCreateWorktree).toHaveBeenCalledTimes(1);
});

it.each(['success', 'failure'])('reloads a reopened visit after %s without inheriting the old result', async (outcome) => {
	const { picker, reply, creation, select } = await heldCreate();
	picker.close();
	await picker.open();
	expect(picker.isCreating).toBe(true);
	await picker.refresh();
	await picker.create(draft);
	expect(getGitWorktrees).toHaveBeenCalledTimes(1);
	if (outcome === 'success') reply.resolve(receipt);
	else reply.resolve({ ...scope, success: false, error: 'Destination occupied' });
	await expect(creation).resolves.toEqual({
		target, result: outcome === 'success' ? { createdPath: receipt.worktreePath } : { error: 'Destination occupied' },
	});
	await picker.syncCatalog();
	expect(getGitWorktrees).toHaveBeenCalledTimes(2);
	expect(gitCreateWorktree).toHaveBeenCalledTimes(1);
	expect(picker.createResult).toBeNull();
	expect(picker.canUseGit).toBe(true);
	expect(select).not.toHaveBeenCalled();
});

it('does not hold a different executor or refresh it for a retired visit', async () => {
	const { picker, host, reply, creation, select } = await heldCreate();
	host.target = { executorId: 'other', projectPath: target.projectPath };
	await picker.syncCatalog();
	expect(picker.isOpen).toBe(false);
	await picker.open();
	expect(picker.canUseGit).toBe(true);
	reply.resolve(receipt);
	await expect(creation).resolves.toEqual({ target, result: { createdPath: receipt.worktreePath } });
	expect(getGitWorktrees).toHaveBeenCalledTimes(2);
	expect(picker.createResult).toBeNull();
	expect(select).not.toHaveBeenCalled();
});
