import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeResponse } from '$shared/file-contracts';
import { getTree } from '$lib/api/files.js';
import { ApiError } from '$lib/api/client.js';
import { SingletonSurfaceRegistry } from '../singleton-surfaces.svelte.js';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import {
	localExecutor,
	remoteExecutor,
} from '$lib/executors/__tests__/fixtures.js';

vi.mock('$lib/api/files.js', () => ({ getTree: vi.fn() }));

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.resetAllMocks();
});

function response(directoryPath = '/workspace'): FileTreeResponse {
	return {
		fileRootPath: '/workspace',
		homeDirectory: null,
		directory: {
			path: directoryPath,
			relativePath: '',
			parentPath: null,
			breadcrumbs: [],
		},
		entries: [],
	};
}

function createController(executors?: ExecutorsStore) {
	const deps = createGitSurfaceTestDeps();
	const registry = new SingletonSurfaceRegistry({
		...deps,
		executors,
		createCommit: () => new CommitController(deps),
		createPullRequests: () => new PullRequestsStore(),
	});
	cleanups.push(() => registry.destroy());
	const controller = registry.files();
	controller.setProjectState({
		kind: 'available',
		project: { chatId: 'chat', projectPath: '/workspace', effectiveProjectKey: '/workspace' },
	});
	return controller;
}

describe('FilesSurfaceController reveal', () => {
	it('reveals the newest request after the first tree load', async () => {
		const initial = Promise.withResolvers<FileTreeResponse>();
		vi.mocked(getTree)
			.mockReturnValueOnce(initial.promise)
			.mockResolvedValue(response('/workspace/src'));
		const controller = createController();
		controller.setPresentationVisible(true);
		controller.revealFile('/workspace', 'old.ts');
		controller.revealFile('/workspace/src', 'new.ts');
		flushSync();
		expect(getTree).toHaveBeenCalledTimes(1);
		initial.resolve(response());
		await vi.waitFor(() =>
			expect(controller.tree.focusPathAfterNavigation).toBe('/workspace/src/new.ts'),
		);
		expect(getTree).toHaveBeenLastCalledWith(
			{ directoryPath: '/workspace/src', executorId: 'local' },
			expect.anything(),
		);
	});

	it.each(['hide', 'dispose', 'project'] as const)(
		'cancels a pending reveal on %s',
		async (action) => {
			const initial = Promise.withResolvers<FileTreeResponse>();
			vi.mocked(getTree).mockReturnValueOnce(initial.promise).mockResolvedValue(response());
			const controller = createController();
			controller.setPresentationVisible(true);
			controller.revealFile('/workspace', 'cancelled/file.ts');
			if (action === 'hide') controller.setPresentationVisible(false);
			else if (action === 'dispose') {
				controller.dispose();
				controller.setProjectState({
					kind: 'available',
					project: { chatId: 'chat', projectPath: '/workspace', effectiveProjectKey: '/workspace' },
				});
			} else
				controller.setProjectState({
					kind: 'available',
					project: { chatId: 'other', projectPath: '/other', effectiveProjectKey: '/other' },
				});
			initial.resolve(response());
			await initial.promise;
			flushSync();
			controller.setPresentationVisible(true);
			await vi.waitFor(() => expect(controller.tree.readyResponse).not.toBeNull());
			flushSync();
			expect(controller.tree.focusPathAfterNavigation).toBeNull();
			expect(getTree).not.toHaveBeenCalledWith(
				{ directoryPath: '/workspace/cancelled', executorId: 'local' },
				expect.anything(),
			);
		},
	);

	it('waits for project resolution instead of using the retained tree root', async () => {
		vi.mocked(getTree).mockResolvedValue(response());
		const controller = createController();
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(controller.tree.readyResponse).not.toBeNull());
		controller.setProjectState({
			kind: 'resolving',
			context: { chatId: 'chat', projectPath: '/workspace' },
		});
		controller.revealFile('/workspace', 'resolved.ts');
		flushSync();
		expect(getTree).toHaveBeenCalledTimes(1);
		expect(controller.tree.readyResponse).not.toBeNull();
		controller.setProjectState({
			kind: 'available',
			project: { chatId: 'chat', projectPath: '/workspace', effectiveProjectKey: '/workspace' },
		});
		await vi.waitFor(() =>
			expect(controller.tree.focusPathAfterNavigation).toBe('/workspace/resolved.ts'),
		);
	});
});

describe('FilesSurfaceController executor browsing', () => {
	it('browses the Local base without a chat and follows the next selected chat', async () => {
		vi.mocked(getTree).mockResolvedValue(response());
		const controller = createController();
		controller.setProjectState({ kind: 'absent' });
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(controller.tree.readyResponse).not.toBeNull());
		expect(getTree).toHaveBeenCalledWith({ executorId: 'local', directoryPath: '' }, expect.anything());
		expect(controller.browsingExecutor).toBe(true);
		controller.setProjectState({ kind: 'absent' });
		expect(getTree).toHaveBeenCalledTimes(1);
		vi.mocked(getTree).mockResolvedValue(response('/workspace/chat'));
		controller.setProjectState({
			kind: 'available',
			project: {
				chatId: 'next',
				projectPath: '/workspace/chat',
				effectiveProjectKey: '/workspace/chat',
			},
		});
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/workspace/chat'));
		expect(controller.browsingExecutor).toBe(false);
	});

	function executorStore() {
		const executors = new ExecutorsStore();
		executors.applySnapshot([
			localExecutor,
			{
				...remoteExecutor,
				machineServices: { files: true, git: false, gh: false, terminals: false },
			},
		]);
		return executors;
	}

	it.each([false, true])(
		'refreshes root metadata and fences pending loads without an offline edge (browsing: %s)',
		async (browsing) => {
			const executors = executorStore();
			const before = response('/worker/project');
			const after = { ...before, fileRootPath: '/', homeDirectory: null };
			const stale = Promise.withResolvers<FileTreeResponse>();
			vi.mocked(getTree)
				.mockResolvedValueOnce(before)
				.mockReturnValueOnce(stale.promise)
				.mockResolvedValue(after);
			const controller = createController(executors);
			controller.setProjectState({
				kind: 'available',
				project: {
					executorId: remoteExecutor.id,
					chatId: 'chat',
					projectPath: '/worker/project',
					effectiveProjectKey: '/worker/project',
				},
			});
			if (browsing) controller.selectExecutor(remoteExecutor.id);
			controller.setPresentationVisible(true);
			flushSync();
			await vi.waitFor(() => expect(controller.tree.readyResponse).toEqual(before));
			controller.tree.childrenCache = new Map([['/worker/project/old', []]]);
			const loading = controller.tree.refresh();
			const signal = vi.mocked(getTree).mock.calls[1][1]?.signal;
			executors.applySnapshot(
				executors.executors.map((executor) =>
					executor.id === remoteExecutor.id
						? { ...executor, instanceId: 'replacement', projectBasePath: '/' }
						: executor,
				),
			);
			flushSync();
			expect(signal?.aborted).toBe(true);
			expect(controller.tree.childrenCache.size).toBe(0);
			await vi.waitFor(() => expect(controller.tree.readyResponse).toEqual(after));
			stale.resolve(before);
			await loading;
			expect(controller.tree.readyResponse).toEqual(after);
			expect(getTree).toHaveBeenLastCalledWith(
				{ executorId: remoteExecutor.id, directoryPath: '/worker/project' },
				expect.anything(),
			);
		},
	);

	it('tries the same folder on the destination, fences the old response, and returns to the current chat explicitly', async () => {
		const executors = executorStore();
		const oldRequest = Promise.withResolvers<FileTreeResponse>();
		vi.mocked(getTree)
			.mockReturnValueOnce(oldRequest.promise)
			.mockResolvedValue(response('/worker'));
		const controller = createController(executors);
		controller.setPresentationVisible(true);
		const signal = vi.mocked(getTree).mock.calls[0][1]?.signal;
		controller.selectExecutor(remoteExecutor.id);
		expect(signal?.aborted).toBe(true);
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/worker'));
		expect(getTree).toHaveBeenLastCalledWith(
			{ executorId: remoteExecutor.id, directoryPath: '/workspace' },
			expect.anything(),
		);
		oldRequest.resolve(response('/workspace/stale'));
		await oldRequest.promise;
		flushSync();
		expect(controller.tree.currentDirectoryPath).toBe('/worker');
		controller.setProjectState({
			kind: 'available',
			project: {
				chatId: 'other-chat',
				executorId: 'local',
				projectPath: '/other-project',
				effectiveProjectKey: '/other-project',
			},
		});
		expect(controller.tree.executorId).toBe(remoteExecutor.id);
		expect(getTree).toHaveBeenCalledTimes(2);
		vi.mocked(getTree).mockResolvedValue(response('/other-project'));
		controller.goToChatProject();
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/other-project'));
		expect(getTree).toHaveBeenCalledTimes(3);
		expect(getTree).toHaveBeenLastCalledWith(
			{ executorId: 'local', directoryPath: '/other-project' },
			expect.anything(),
		);
		expect(controller.browsingExecutor).toBe(false);
	});

	it.each([
		'FILE_TREE_DIRECTORY_NOT_FOUND',
		'FILE_TREE_DIRECTORY_REQUIRED',
		'outside_project_base',
	])('falls back to the destination project base for %s', async (code) => {
		const executors = executorStore();
		vi.mocked(getTree).mockResolvedValueOnce(response('/workspace/nested'));
		const controller = createController(executors);
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/workspace/nested'));
		vi.mocked(getTree)
			.mockRejectedValueOnce(new ApiError(404, 'Directory unavailable', code))
			.mockResolvedValue(response('/worker'));
		controller.selectExecutor(remoteExecutor.id);
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/worker'));
		expect(getTree).toHaveBeenNthCalledWith(
			2,
			{ executorId: remoteExecutor.id, directoryPath: '/workspace/nested' },
			expect.anything(),
		);
		expect(getTree).toHaveBeenLastCalledWith(
			{ executorId: remoteExecutor.id, directoryPath: '' },
			expect.anything(),
		);
	});

	it('retains a folder that exists on the destination executor', async () => {
		const executors = executorStore();
		vi.mocked(getTree).mockResolvedValue(response('/workspace/shared'));
		const controller = createController(executors);
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/workspace/shared'));
		controller.selectExecutor(remoteExecutor.id);
		await vi.waitFor(() => expect(controller.tree.readyResponse).not.toBeNull());
		expect(getTree).toHaveBeenCalledTimes(2);
		expect(getTree).toHaveBeenLastCalledWith(
			{ executorId: remoteExecutor.id, directoryPath: '/workspace/shared' },
			expect.anything(),
		);
	});

	it.each([
		[403, 'FILE_TREE_PERMISSION_DENIED'],
		[503, 'EXECUTOR_UNAVAILABLE'],
	] as const)('does not hide %s/%s behind a project-base retry', async (status, code) => {
		const executors = executorStore();
		vi.mocked(getTree).mockResolvedValueOnce(response('/workspace/nested'));
		const controller = createController(executors);
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/workspace/nested'));
		vi.mocked(getTree).mockRejectedValue(new ApiError(status, 'Directory unavailable', code));
		controller.selectExecutor(remoteExecutor.id);
		await vi.waitFor(() => expect(controller.tree.navigation.kind).toBe('error'));
		expect(getTree).toHaveBeenCalledTimes(2);
		expect(getTree).toHaveBeenLastCalledWith(
			{ executorId: remoteExecutor.id, directoryPath: '/workspace/nested' },
			expect.anything(),
		);
		expect(controller.tree.executorId).toBe(remoteExecutor.id);
	});

	it('browses without a chat and aborts offline requests without falling back to Local', async () => {
		const executors = executorStore();
		const pending = Promise.withResolvers<FileTreeResponse>();
		vi.mocked(getTree).mockReturnValueOnce(pending.promise).mockResolvedValue(response('/worker'));
		const controller = createController(executors);
		controller.setProjectState({ kind: 'absent' });
		controller.selectExecutor(remoteExecutor.id);
		controller.setPresentationVisible(true);
		flushSync();
		const signal = vi.mocked(getTree).mock.calls[0][1]?.signal;
		executors.applySnapshot([localExecutor, { ...remoteExecutor, availability: 'offline' }]);
		flushSync();
		expect(signal?.aborted).toBe(true);
		pending.resolve(response('/worker/stale'));
		await pending.promise;
		expect(controller.tree.readyResponse).toBeNull();
		controller.selectExecutor('33333333-3333-4333-8333-333333333333');
		controller.selectExecutor(remoteExecutor.id);
		expect(getTree).toHaveBeenCalledTimes(1);
		executors.applySnapshot(executorStore().executors);
		flushSync();
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/worker'));
		expect(getTree).toHaveBeenCalledTimes(2);
		expect(controller.tree.executorId).toBe(remoteExecutor.id);
		expect(controller.canGoToChatProject).toBe(false);
	});

	it('reveals an existing file on its owning executor after browsing another executor', async () => {
		const executors = executorStore();
		vi.mocked(getTree).mockResolvedValue(response());
		const controller = createController(executors);
		controller.setPresentationVisible(true);
		controller.selectExecutor(remoteExecutor.id);
		await vi.waitFor(() => expect(controller.tree.readyResponse).not.toBeNull());
		controller.revealFile('/workspace', 'file.txt', 'local');
		flushSync();
		await vi.waitFor(() =>
			expect(controller.tree.focusPathAfterNavigation).toBe('/workspace/file.txt'),
		);
		expect(controller.tree.executorId).toBe('local');
	});

	it('revalidates the selected directory after reconnect even while the browser is hidden', async () => {
		const executors = executorStore();
		vi.mocked(getTree).mockResolvedValue(response('/worker/nested'));
		const controller = createController(executors);
		controller.selectExecutor(remoteExecutor.id);
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/worker/nested'));
		controller.setPresentationVisible(false);
		executors.applySnapshot([localExecutor, { ...remoteExecutor, availability: 'offline' }]);
		flushSync();
		executors.applySnapshot(executorStore().executors);
		flushSync();
		expect(getTree).toHaveBeenCalledTimes(1);
		expect(controller.tree.navigation.kind).toBe('loading');
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(controller.tree.navigation.kind).toBe('ready'));
		expect(getTree).toHaveBeenLastCalledWith(
			{ executorId: remoteExecutor.id, directoryPath: '/worker/nested' },
			expect.anything(),
		);
	});
});
