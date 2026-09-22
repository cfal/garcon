import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeResponse } from '$shared/file-contracts';
import { getTree } from '$lib/api/files.js';
import { SingletonSurfaceRegistry } from '../singleton-surfaces.svelte.js';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import {
	localExecutionNode,
	remoteExecutionNode,
} from '$lib/execution-nodes/__tests__/fixtures.js';

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

function createController(executionNodes?: ExecutionNodesStore) {
	const deps = createGitSurfaceTestDeps();
	const registry = new SingletonSurfaceRegistry({
		...deps,
		executionNodes,
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
			{ directoryPath: '/workspace/src', nodeId: 'local' },
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
				{ directoryPath: '/workspace/cancelled', nodeId: 'local' },
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

describe('FilesSurfaceController node browsing', () => {
	function nodeStore() {
		const nodes = new ExecutionNodesStore();
		nodes.applySnapshot([
			localExecutionNode,
			{ ...remoteExecutionNode, machineServices: { files: true, git: false, gh: false, terminals: false } },
		]);
		return nodes;
	}

	it.each([false, true])('refreshes root metadata and fences pending loads without an offline edge (browsing: %s)', async (browsing) => {
		const nodes = nodeStore();
		const before = response('/worker/project');
		const after = { ...before, fileRootPath: '/', homeDirectory: null };
		const stale = Promise.withResolvers<FileTreeResponse>();
		vi.mocked(getTree).mockResolvedValueOnce(before).mockReturnValueOnce(stale.promise).mockResolvedValue(after);
		const controller = createController(nodes);
		controller.setProjectState({ kind: 'available', project: {
			nodeId: remoteExecutionNode.id, chatId: 'chat', projectPath: '/worker/project', effectiveProjectKey: '/worker/project',
		} });
		if (browsing) controller.selectNode(remoteExecutionNode.id);
		controller.setPresentationVisible(true);
		flushSync();
		await vi.waitFor(() => expect(controller.tree.readyResponse).toEqual(before));
		controller.tree.childrenCache = new Map([['/worker/project/old', []]]);
		const loading = controller.tree.refresh();
		const signal = vi.mocked(getTree).mock.calls[1][1]?.signal;
		nodes.applySnapshot(nodes.nodes.map((node) => node.id === remoteExecutionNode.id
			? { ...node, instanceId: 'replacement', projectBasePath: '/' } : node));
		flushSync();
		expect(signal?.aborted).toBe(true);
		expect(controller.tree.childrenCache.size).toBe(0);
		await vi.waitFor(() => expect(controller.tree.readyResponse).toEqual(after));
		stale.resolve(before);
		await loading;
		expect(controller.tree.readyResponse).toEqual(after);
		expect(getTree).toHaveBeenLastCalledWith({ nodeId: remoteExecutionNode.id, directoryPath: '/worker/project' }, expect.anything());
	});

	it('opens the destination root, fences the old response, and returns to the current chat explicitly', async () => {
		const nodes = nodeStore();
		const oldRequest = Promise.withResolvers<FileTreeResponse>();
		vi.mocked(getTree)
			.mockReturnValueOnce(oldRequest.promise)
			.mockResolvedValue(response('/worker'));
		const controller = createController(nodes);
		controller.setPresentationVisible(true);
		const signal = vi.mocked(getTree).mock.calls[0][1]?.signal;
		controller.selectNode(remoteExecutionNode.id);
		expect(signal?.aborted).toBe(true);
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/worker'));
		expect(getTree).toHaveBeenLastCalledWith(
			{ nodeId: remoteExecutionNode.id, directoryPath: '' },
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
				nodeId: 'local',
				projectPath: '/other-project',
				effectiveProjectKey: '/other-project',
			},
		});
		expect(controller.tree.nodeId).toBe(remoteExecutionNode.id);
		expect(getTree).toHaveBeenCalledTimes(2);
		vi.mocked(getTree).mockResolvedValue(response('/other-project'));
		controller.goToChatProject();
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/other-project'));
		expect(getTree).toHaveBeenCalledTimes(3);
		expect(getTree).toHaveBeenLastCalledWith(
			{ nodeId: 'local', directoryPath: '/other-project' },
			expect.anything(),
		);
		expect(controller.browsingNode).toBe(false);
	});

	it('browses without a chat and aborts offline requests without falling back to Local', async () => {
		const nodes = nodeStore();
		const pending = Promise.withResolvers<FileTreeResponse>();
		vi.mocked(getTree).mockReturnValueOnce(pending.promise).mockResolvedValue(response('/worker'));
		const controller = createController(nodes);
		controller.setProjectState({ kind: 'absent' });
		controller.setPresentationVisible(true);
		controller.selectNode(remoteExecutionNode.id);
		flushSync();
		const signal = vi.mocked(getTree).mock.calls[0][1]?.signal;
		nodes.applySnapshot([localExecutionNode, { ...remoteExecutionNode, availability: 'offline' }]);
		flushSync();
		expect(signal?.aborted).toBe(true);
		pending.resolve(response('/worker/stale'));
		await pending.promise;
		expect(controller.tree.readyResponse).toBeNull();
		controller.selectNode('33333333-3333-4333-8333-333333333333');
		controller.selectNode(remoteExecutionNode.id);
		expect(getTree).toHaveBeenCalledTimes(1);
		nodes.applySnapshot(nodeStore().nodes);
		flushSync();
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/worker'));
		expect(getTree).toHaveBeenCalledTimes(2);
		expect(controller.tree.nodeId).toBe(remoteExecutionNode.id);
		expect(controller.canGoToChatProject).toBe(false);
	});

	it('reveals an existing file on its owning node after browsing another node', async () => {
		const nodes = nodeStore();
		vi.mocked(getTree).mockResolvedValue(response());
		const controller = createController(nodes);
		controller.setPresentationVisible(true);
		controller.selectNode(remoteExecutionNode.id);
		await vi.waitFor(() => expect(controller.tree.readyResponse).not.toBeNull());
		controller.revealFile('/workspace', 'file.txt', 'local');
		flushSync();
		await vi.waitFor(() =>
			expect(controller.tree.focusPathAfterNavigation).toBe('/workspace/file.txt'),
		);
		expect(controller.tree.nodeId).toBe('local');
	});

	it('revalidates the selected directory after reconnect even while the browser is hidden', async () => {
		const nodes = nodeStore();
		vi.mocked(getTree).mockResolvedValue(response('/worker/nested'));
		const controller = createController(nodes);
		controller.selectNode(remoteExecutionNode.id);
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(controller.tree.currentDirectoryPath).toBe('/worker/nested'));
		controller.setPresentationVisible(false);
		nodes.applySnapshot([localExecutionNode, { ...remoteExecutionNode, availability: 'offline' }]);
		flushSync();
		nodes.applySnapshot(nodeStore().nodes);
		flushSync();
		expect(getTree).toHaveBeenCalledTimes(1);
		expect(controller.tree.navigation.kind).toBe('loading');
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(controller.tree.navigation.kind).toBe('ready'));
		expect(getTree).toHaveBeenLastCalledWith(
			{ nodeId: remoteExecutionNode.id, directoryPath: '/worker/nested' },
			expect.anything(),
		);
	});
});
