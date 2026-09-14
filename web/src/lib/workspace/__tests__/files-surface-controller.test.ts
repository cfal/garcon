import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeResponse } from '$shared/file-contracts';
import { getTree } from '$lib/api/files.js';
import { SingletonSurfaceRegistry } from '../singleton-surfaces.svelte.js';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';

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

function createController() {
	const deps = createGitSurfaceTestDeps();
	const registry = new SingletonSurfaceRegistry({
		...deps,
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
			{ directoryPath: '/workspace/src' },
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
				{ directoryPath: '/workspace/cancelled' },
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
