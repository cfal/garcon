import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { PullRequestsStore } from '$lib/stores/pull-requests.svelte.js';
import { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
import FilesPanelTestHost from './FilesPanelTestHost.svelte';
import { setFilesPanelTestContext } from './files-panel-test-context.js';

afterEach(cleanup);

describe('FilesPanel', () => {
	it('opens a sibling-project file against the canonical project base', async () => {
		const resolveFileIdentity = vi.fn(async ({ relativePath }: { relativePath: string }) => ({
			success: true as const,
			identity: {
				canonicalFileRootPath: '/workspace',
				normalizedRelativePath: relativePath,
			},
		}));
		const fileSessions = new FileSessionRegistry({
			getIsMobile: () => false,
			getDefaultPlacement: () => 'dialog',
			getEditorSettings: () => ({
				get wordWrap() {
					return false;
				},
				get showLineNumbers() {
					return true;
				},
				get fontSize() {
					return 12;
				},
			}),
			getPlacement: () => ({
				async placeFileSession(_sessionId, _target, publication) {
					publication.publish();
					return 'placed';
				},
				async focusFileSession() {},
			}),
			resolveFileIdentity,
			readText: vi.fn(async () => ({ content: 'hello' })),
			saveText: vi.fn(async () => ({ success: true })),
			fetchContent: vi.fn(async () => new Response('content')),
		});
		const singletonSurfaces = new SingletonSurfaceRegistry({
			createCommit: () => new CommitController({}),
			createPullRequests: () => new PullRequestsStore(),
			gitBranchActions: new GitBranchSelectorState(),
			gitMutations: new GitMutationCoordinator({ onChanged: vi.fn() }),
			getCurrentEffectiveProjectKey: () => '/workspace/chat-project',
		});
		const tree = singletonSurfaces.files().tree;
		tree.navigation = {
			kind: 'ready',
			response: {
				fileRootPath: '/workspace',
				directory: {
					path: '/workspace/sibling-project',
					relativePath: 'sibling-project',
					parentPath: '/workspace',
					breadcrumbs: [
						{ name: 'workspace', path: '/workspace' },
						{ name: 'sibling-project', path: '/workspace/sibling-project' },
					],
				},
				entries: [
					{
						name: 'file.ts',
						path: '/workspace/sibling-project/file.ts',
						relativePath: 'sibling-project/file.ts',
						type: 'file',
						size: 5,
						modified: null,
						permissionsRwx: 'rw-r--r--',
					},
				],
			},
		};

		setFilesPanelTestContext({ fileSessions, singletonSurfaces });
		render(FilesPanelTestHost);
		await fireEvent.click(screen.getByRole('rowheader', { name: 'file.ts' }));

		await waitFor(() =>
			expect(resolveFileIdentity).toHaveBeenCalledWith({
				projectPath: '/workspace',
				relativePath: 'sibling-project/file.ts',
			}),
		);
	});
});
