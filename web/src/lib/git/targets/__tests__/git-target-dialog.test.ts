import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatsApi from '$lib/api/chats';
import * as gitApi from '$lib/api/git';
import type { GitTargetCandidate, GitWorktreeItem } from '$lib/api/git';
import * as m from '$lib/paraglide/messages.js';
import { GitTargetDialogState } from '$lib/git/targets/git-target-dialog.svelte.js';

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn(),
}));

vi.mock('$lib/api/git', () => ({
	getGitTargetCandidates: vi.fn(),
	getGitWorktrees: vi.fn(),
	gitCreateWorktree: vi.fn(),
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function makeWorktree(path: string, branch: string): GitWorktreeItem {
	return {
		name: branch,
		path,
		branch,
		isCurrent: branch === 'main',
		isMain: branch === 'main',
		isPathMissing: false,
	};
}

function makeTarget(overrides: Partial<GitTargetCandidate> = {}): GitTargetCandidate {
	return {
		projectPath: '/workspace/repo',
		repoRoot: '/workspace/repo',
		worktreePath: '/workspace/repo',
		label: 'repo',
		branch: 'main',
		source: 'worktree',
		isCurrent: false,
		isMissing: false,
		...overrides,
	};
}

async function advanceValidation(): Promise<void> {
	await vi.advanceTimersByTimeAsync(150);
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('GitTargetDialogState', () => {
	it('debounces validation and ignores an aborted stale response', async () => {
		const first = deferred<Awaited<ReturnType<typeof chatsApi.validateStart>>>();
		const second = deferred<Awaited<ReturnType<typeof chatsApi.validateStart>>>();
		vi.mocked(chatsApi.validateStart)
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		const dialog = new GitTargetDialogState({ initialPath: '/workspace/first' });

		dialog.scheduleValidation();
		await advanceValidation();
		const firstSignal = vi.mocked(chatsApi.validateStart).mock.calls[0]?.[1]?.signal;
		expect(dialog.validationStatus).toBe('checking');

		dialog.setCandidatePath('/workspace/second');
		dialog.scheduleValidation();
		expect(firstSignal?.aborted).toBe(true);
		await advanceValidation();

		second.resolve({ valid: true, isGitRepo: true });
		await flushPromises();
		expect(dialog.validationStatus).toBe('valid');

		first.resolve({ valid: false, errorCode: 'path_not_found' });
		await flushPromises();
		expect(dialog.validationStatus).toBe('valid');
		expect(dialog.validationError).toBeNull();
	});

	it('maps invalid paths and non-Git directories to actionable validation errors', async () => {
		const dialog = new GitTargetDialogState({ initialPath: '/outside' });
		vi.mocked(chatsApi.validateStart).mockResolvedValueOnce({
			valid: false,
			errorCode: 'outside_base_dir',
		});

		dialog.scheduleValidation();
		await advanceValidation();
		expect(dialog.validationStatus).toBe('invalid');
		expect(dialog.validationError).toBe(m.chat_new_chat_errors_path_outside_base_dir());

		dialog.setCandidatePath('/workspace/plain');
		vi.mocked(chatsApi.validateStart).mockResolvedValueOnce({ valid: true, isGitRepo: false });
		dialog.scheduleValidation();
		await advanceValidation();
		expect(dialog.validationStatus).toBe('invalid');
		expect(dialog.validationError).toBe(m.git_target_not_git_repo());
	});

	it('returns blank candidates to idle and cancels pending validation', async () => {
		const dialog = new GitTargetDialogState({ initialPath: '/workspace/repo' });
		dialog.scheduleValidation();
		dialog.setCandidatePath('   ');
		dialog.scheduleValidation();
		await advanceValidation();

		expect(chatsApi.validateStart).not.toHaveBeenCalled();
		expect(dialog.validationStatus).toBe('idle');
		expect(dialog.validationError).toBeNull();
		expect(dialog.canConfirm).toBe(false);
	});

	it('keeps only the newest worktree load and its loading state', async () => {
		const first = deferred<Awaited<ReturnType<typeof gitApi.getGitWorktrees>>>();
		const second = deferred<Awaited<ReturnType<typeof gitApi.getGitWorktrees>>>();
		vi.mocked(gitApi.getGitWorktrees)
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		const dialog = new GitTargetDialogState({ initialPath: '/workspace/repo' });

		const firstLoad = dialog.loadWorktrees();
		const firstSignal = vi.mocked(gitApi.getGitWorktrees).mock.calls[0]?.[1]?.signal;
		const secondLoad = dialog.loadWorktrees();
		expect(firstSignal?.aborted).toBe(true);

		first.resolve({ worktrees: [makeWorktree('/workspace/stale', 'stale')] });
		await firstLoad;
		expect(dialog.isLoadingWorktrees).toBe(true);
		expect(dialog.worktrees).toEqual([]);

		const current = makeWorktree('/workspace/repo-feature', 'feature');
		second.resolve({ worktrees: [current] });
		await secondLoad;
		expect(dialog.isLoadingWorktrees).toBe(false);
		expect(dialog.worktrees).toEqual([current]);
	});

	it('reports current worktree load failures without retaining stale rows', async () => {
		vi.mocked(gitApi.getGitWorktrees).mockRejectedValueOnce(new Error('offline'));
		const dialog = new GitTargetDialogState({ initialPath: '/workspace/repo' });
		dialog.worktrees = [makeWorktree('/workspace/old', 'old')];

		await dialog.loadWorktrees();

		expect(dialog.isLoadingWorktrees).toBe(false);
		expect(dialog.worktrees).toEqual([]);
		expect(dialog.worktreeError).toBe(m.git_target_load_worktrees_failed());
	});

	it('selects a successfully created worktree and preserves server failures', async () => {
		const dialog = new GitTargetDialogState({ initialPath: '/workspace/repo' });
		dialog.worktreePickerOpen = true;
		vi.mocked(gitApi.gitCreateWorktree).mockResolvedValueOnce({
			success: true,
			worktreePath: '/workspace/canonical-feature',
		});

		await dialog.createWorktree('/workspace/feature', 'feature', 'main');

		expect(gitApi.gitCreateWorktree).toHaveBeenCalledWith('/workspace/repo', '/workspace/feature', {
			branch: 'feature',
			baseRef: 'main',
		});
		expect(dialog.candidatePath).toBe('/workspace/canonical-feature');
		expect(dialog.validationStatus).toBe('valid');
		expect(dialog.worktreePickerOpen).toBe(false);
		expect(dialog.isCreatingWorktree).toBe(false);

		vi.mocked(gitApi.gitCreateWorktree).mockResolvedValueOnce({
			success: false,
			error: 'branch already exists',
		});
		await dialog.createWorktree('/workspace/other');
		expect(dialog.worktreeError).toBe('branch already exists');
		expect(dialog.candidatePath).toBe('/workspace/canonical-feature');
	});

	it('resolves an exact worktree target before broader fallbacks', async () => {
		const byProjectPath = makeTarget({
			label: 'project match',
			projectPath: '/workspace/repo',
			worktreePath: '/workspace/elsewhere',
		});
		const exactWorktree = makeTarget({ label: 'exact worktree' });
		vi.mocked(gitApi.getGitTargetCandidates).mockResolvedValueOnce({
			targets: [byProjectPath, exactWorktree],
		});
		const dialog = new GitTargetDialogState({ initialPath: ' /workspace/repo ' });
		dialog.validationStatus = 'valid';

		const target = await dialog.resolveConfirmedTarget();

		expect(gitApi.getGitTargetCandidates).toHaveBeenCalledWith(
			'/workspace/repo',
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(target).toBe(exactWorktree);
		expect(dialog.isConfirming).toBe(false);
	});

	it('invalidates confirmation when no usable target exists', async () => {
		vi.mocked(gitApi.getGitTargetCandidates).mockResolvedValueOnce({
			targets: [makeTarget({ isMissing: true })],
		});
		const dialog = new GitTargetDialogState({ initialPath: '/workspace/repo' });
		dialog.validationStatus = 'valid';

		await expect(dialog.resolveConfirmedTarget()).resolves.toBeNull();

		expect(dialog.validationStatus).toBe('invalid');
		expect(dialog.validationError).toBe(m.git_target_no_targets());
		expect(dialog.isConfirming).toBe(false);
	});

	it('aborts pending work and prevents disposed requests from publishing', async () => {
		const targets = deferred<Awaited<ReturnType<typeof gitApi.getGitTargetCandidates>>>();
		vi.mocked(gitApi.getGitTargetCandidates).mockImplementationOnce(() => targets.promise);
		const dialog = new GitTargetDialogState({ initialPath: '/workspace/repo' });
		dialog.scheduleValidation();
		dialog.validationStatus = 'valid';
		const confirmation = dialog.resolveConfirmedTarget();
		const targetSignal = vi.mocked(gitApi.getGitTargetCandidates).mock.calls[0]?.[1]?.signal;

		dialog.dispose();
		expect(targetSignal?.aborted).toBe(true);
		await advanceValidation();
		expect(chatsApi.validateStart).not.toHaveBeenCalled();

		targets.resolve({ targets: [makeTarget()] });
		await expect(confirmation).resolves.toBeNull();
		expect(dialog.isConfirming).toBe(false);
	});
});
