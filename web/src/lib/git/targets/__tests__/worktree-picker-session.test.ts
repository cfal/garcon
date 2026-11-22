import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { getGitWorktrees, gitCreateWorktree } from '$lib/api/git.js';
import { WorktreePickerSession } from '../worktree-picker-session.svelte.js';

vi.mock('$lib/api/git.js', () => ({ getGitWorktrees: vi.fn(), gitCreateWorktree: vi.fn() }));

const target = { executorId: 'remote', projectPath: '/repo ' };
const draft = { newBranch: 'fresh-name', worktreePath: '/dest ' };
const receipt = { success: true, worktreePath: '/canonical ' };

async function heldCreate() {
	const host = { target, context: 'worker-1' as string | null };
	const select = vi.fn();
	const picker = new WorktreePickerSession({
		target: () => host.target,
		servingContext: () => host.context,
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
	vi.mocked(getGitWorktrees).mockResolvedValue({ worktrees: [] });
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

it.each(['success', 'failure'])('reloads a reopened visit after %s without inheriting the old result', async (outcome) => {
	const { picker, reply, creation, select } = await heldCreate();
	picker.close();
	await picker.open();
	expect(picker.isCreating).toBe(true);
	await picker.refresh();
	await picker.create(draft);
	expect(getGitWorktrees).toHaveBeenCalledTimes(1);
	if (outcome === 'success') reply.resolve(receipt);
	else reply.resolve({ success: false, error: 'Destination occupied' });
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
