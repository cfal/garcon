import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import * as chatsApi from '$lib/api/chats';
import * as gitApi from '$lib/api/git';
import type { GitWorktreeItem } from '$lib/api/git';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { ProjectPathDialogState } from '$lib/project-paths/project-path-dialog-state.svelte.js';

vi.mock('$lib/api/chats', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/chats')>();
	return {
		...actual,
		validateStart: vi.fn(),
	};
});

vi.mock('$lib/api/git', () => ({
	getGitWorktrees: vi.fn(),
	gitCreateWorktree: vi.fn(),
}));

function makeWorktree(path: string, branch: string): GitWorktreeItem {
	return {
		name: branch,
		path,
		branch,
		isCurrent: false,
		isMain: branch === 'main',
		isPathMissing: false,
		lastModifiedAt: null,
	};
}

describe('ProjectPathDialogState', () => {
	it('distinguishes spaced paths from the current path and validates the exact candidate', async () => {
		vi.useFakeTimers();
		const dialog = new ProjectPathDialogState();
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		try {
			dialog.open('/workspace/project', 'local', '/workspace/project ');
			expect(dialog.isUnchanged).toBe(false);
			dialog.scheduleValidation();
			await vi.advanceTimersByTimeAsync(250);
			expect(chatsApi.validateStart).toHaveBeenLastCalledWith('/workspace/project ', expect.objectContaining({ executorId: 'local' }));
			expect(dialog.nonblankPath).toBe('/workspace/project ');
			expect(dialog.canSubmit).toBe(true);
			dialog.setCandidatePath('   ');
			expect(dialog.canSubmit).toBe(false);
		} finally {
			dialog.dispose();
			vi.useRealTimers();
		}
	});

	it('fences remote worktree list and creation across executor replacement and dialog retargeting', async () => {
		const executors = new ExecutorsStore();
		const remote = {
			...remoteExecutor,
			machineServices: { ...remoteExecutor.machineServices, git: true },
		};
		executors.applySnapshot([localExecutor, remote]);
		const dialog = new ProjectPathDialogState(executors);
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		dialog.open('/worker/project', remote.id);
		const listing = Promise.withResolvers<{ worktrees: GitWorktreeItem[] }>();
		vi.mocked(gitApi.getGitWorktrees).mockReturnValueOnce(listing.promise);
		const loading = dialog.loadWorktrees();
		expect(gitApi.getGitWorktrees).toHaveBeenLastCalledWith(
			{ executorId: remote.id, projectPath: '/worker/project' },
			expect.any(Object),
		);
		executors.applySnapshot([localExecutor, { ...remote, instanceId: 'replacement' }]);
		listing.resolve({ worktrees: [makeWorktree('/worker/old', 'old')] });
		await loading;
		expect(dialog.worktrees).toEqual([]);

		const creation = Promise.withResolvers<Awaited<ReturnType<typeof gitApi.gitCreateWorktree>>>();
		vi.mocked(gitApi.gitCreateWorktree).mockReturnValueOnce(creation.promise);
		const creating = dialog.createWorktree('/worker/feature', 'feature');
		dialog.open('/local/project', 'local');
		creation.resolve({ success: true, worktreePath: '/worker/feature' });
		await creating;
		expect(dialog.candidatePath).toBe('/local/project');
		expect(gitApi.gitCreateWorktree).toHaveBeenLastCalledWith(
			{ executorId: remote.id, projectPath: '/worker/project' },
			'/worker/feature',
			{ branch: 'feature', baseRef: undefined },
		);
		dialog.close();
	});

	it('revalidates an unchanged path against a new serving context without losing the candidate', async () => {
		vi.useFakeTimers();
		const dialog = new ProjectPathDialogState();
		const old = Promise.withResolvers<Awaited<ReturnType<typeof chatsApi.validateStart>>>();
		vi.mocked(chatsApi.validateStart)
			.mockReset()
			.mockResolvedValueOnce({ valid: true, isGitRepo: false })
			.mockReturnValueOnce(old.promise)
			.mockResolvedValueOnce({ valid: false, errorCode: 'outside_base_dir' });
		try {
			dialog.open('/worker/project', remoteExecutor.id);
			dialog.scheduleValidation('first');
			await vi.advanceTimersByTimeAsync(250);
			expect(dialog.validationStatus).toBe('valid');
			dialog.scheduleValidation('second');
			expect(dialog.validationStatus).toBe('checking');
			vi.advanceTimersByTime(250);
			dialog.scheduleValidation('third');
			old.resolve({ valid: true });
			await vi.advanceTimersByTimeAsync(250);
			expect(dialog.validationStatus).toBe('invalid');
			expect(dialog.candidatePath).toBe('/worker/project');
		} finally {
			dialog.dispose();
			vi.useRealTimers();
		}
	});

	it('validates a proposed candidate every time instead of trusting it as the current path', async () => {
		vi.useFakeTimers();
		const dialog = new ProjectPathDialogState();
		vi.mocked(chatsApi.validateStart)
			.mockReset()
			.mockResolvedValueOnce({ valid: false, errorCode: 'path_not_found' })
			.mockResolvedValueOnce({ valid: true, isGitRepo: true })
			.mockResolvedValueOnce({ valid: false, errorCode: 'path_not_found' });
		try {
			dialog.open('', remoteExecutor.id, '/worker/missing');
			expect(dialog.validationStatus).toBe('idle');
			expect(dialog.isUnchanged).toBe(false);
			dialog.scheduleValidation('context');
			expect(dialog.validationStatus).toBe('checking');
			await vi.advanceTimersByTimeAsync(250);
			expect(chatsApi.validateStart).toHaveBeenLastCalledWith('/worker/missing', {
				executorId: remoteExecutor.id,
				signal: expect.any(AbortSignal),
			});
			expect(dialog.validationStatus).toBe('invalid');

			dialog.setCandidatePath('/worker/project');
			dialog.scheduleValidation('context');
			await vi.advanceTimersByTimeAsync(250);
			expect(dialog.validationStatus).toBe('valid');
			dialog.setCandidatePath('/worker/missing');
			dialog.scheduleValidation('context');
			expect(dialog.validationStatus).toBe('checking');
			await vi.advanceTimersByTimeAsync(250);
			expect(dialog.validationStatus).toBe('invalid');
			expect(chatsApi.validateStart).toHaveBeenCalledTimes(3);
		} finally {
			dialog.dispose();
			vi.useRealTimers();
		}
	});

	it('explains rejected and unconfirmed project path updates', () => {
		const dialog = new ProjectPathDialogState();

		dialog.setSubmitFailure(
			new ApiError(422, 'destination rejected', 'PROJECT_PATH_DESTINATION_REJECTED'),
		);
		expect(dialog.submitError).toMatch(/stayed at its current path/i);

		dialog.setSubmitFailure(
			new ApiError(504, 'outcome unknown', 'PROJECT_PATH_UPDATE_OUTCOME_UNKNOWN'),
		);
		expect(dialog.submitError).toMatch(/retry the same destination/i);

		dialog.setSubmitFailure(
			new ApiError(503, 'raw provider failure', 'PROJECT_PATH_UPDATE_FAILED'),
		);
		expect(dialog.submitError).toBe('Failed to update project path.');
	});
});
