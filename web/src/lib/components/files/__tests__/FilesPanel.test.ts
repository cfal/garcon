import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
import FilesPanelTestHost from './FilesPanelTestHost.svelte';
import { setFilesPanelTestContext } from './files-panel-test-context.js';
import {
	createMemoryFileDraftRepository,
	fileDraftKey,
} from '$lib/files/persistence/file-draft-repository.js';
import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

afterEach(cleanup);

describe('FilesPanel', () => {
	it.each([
		{ presentation: 'window-main', projectState: { kind: 'absent' } },
		{ presentation: 'mobile', projectState: { kind: 'absent' } },
		{
			presentation: 'mobile',
			projectState: {
				kind: 'unavailable',
				context: { chatId: 'chat', projectPath: '/workspace' },
				reason: 'not-found',
			},
		},
		{
			presentation: 'mobile',
			projectState: {
				kind: 'request-failed',
				context: { chatId: 'chat', projectPath: '/workspace' },
				message: 'Project request failed',
			},
		},
	] satisfies Array<{
		presentation: 'window-main' | 'mobile';
		projectState: WorkspaceProjectState;
	}>)(
		'exposes stored drafts independently of project availability ($presentation, $projectState.kind)',
		async ({ presentation, projectState }) => {
			const focusFileSession = vi.fn(async () => {});
			const notifications = new NotificationsStore();
			const repository = createMemoryFileDraftRepository();
			const draftId = fileDraftKey('user', 'deployment', '/workspace', 'draft.txt');
			await repository.putDraft({
				schemaVersion: 1,
				userNamespace: 'user',
				deploymentId: 'deployment',
				documentId: draftId,
				canonicalFileRootPath: '/workspace',
				normalizedRelativePath: 'draft.txt',
				content: 'local text',
				savedAt: 1,
			});
			const fileSessions = new FileSessionRegistry({
				getIsMobile: () => presentation === 'mobile',
				getDefaultPlacement: () => ({ type: 'dialog' }),
				getEditorSettings: () => ({ wordWrap: false, showLineNumbers: true, fontSize: 12 }),
				getPlacement: () => ({ placeFileSession: vi.fn(), focusFileSession }),
				draftRepository: repository,
				deploymentId: 'deployment',
			});
			await fileSessions.initializeRecovery('user');
			const open = vi.spyOn(fileSessions, 'open').mockResolvedValue(null);
			const exportDraft = vi.spyOn(fileSessions, 'exportDraft').mockReturnValue(undefined);
			const gitSurfaceDeps = createGitSurfaceTestDeps();
			const singletonSurfaces = new SingletonSurfaceRegistry({
				...gitSurfaceDeps,
				createCommit: () => new CommitController(gitSurfaceDeps),
				createPullRequests: () => new PullRequestsStore(),
			});
			setFilesPanelTestContext({ fileSessions, singletonSurfaces, notifications });
			try {
				render(FilesPanelTestHost, { presentation, focusFileSession, projectState });
				expect(Object.keys(fileSessions.sessions)).toHaveLength(0);
				expect(
					screen
						.getByRole('region', { name: 'Recovered files' })
						.closest('[inert], [aria-hidden="true"]'),
				).toBeNull();
				open.mockRejectedValueOnce(new Error('Could not open draft'));
				await fireEvent.click(screen.getByRole('button', { name: 'draft.txt' }));
				await waitFor(() =>
					expect(notifications.items).toMatchObject([
						{ tone: 'error', message: 'Could not open draft' },
					]),
				);
				await fireEvent.click(screen.getByRole('button', { name: 'draft.txt' }));
				expect(open).toHaveBeenLastCalledWith({
					fileRootPath: '/workspace',
					relativePath: 'draft.txt',
					mode: 'code',
					origin: presentation,
					reason: 'user-open',
				});
				await fireEvent.click(screen.getByRole('button', { name: 'Export draft for draft.txt' }));
				expect(exportDraft).toHaveBeenCalledWith(draftId);
				await fileSessions.clearRecovery();
				await waitFor(() =>
					expect(screen.queryByRole('region', { name: 'Recovered files' })).toBeNull(),
				);
			} finally {
				await fileSessions.destroyAll();
			}
		},
	);

	it.each(['window-main', 'window-sidebar', 'mobile'] as const)(
		'opens a sibling-project file from the %s presentation against the canonical project base',
		async (presentation) => {
			const resolveFileIdentity = vi.fn(async ({ relativePath }: { relativePath: string }) => ({
				success: true as const,
				identity: {
					canonicalFileRootPath: '/workspace',
					normalizedRelativePath: relativePath,
				},
			}));
			const fileSessions = new FileSessionRegistry({
				getIsMobile: () => presentation === 'mobile',
				getDefaultPlacement: () => ({ type: 'dialog' }),
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
				readText: vi.fn(async () => ({
					content: 'hello',
					path: '/workspace/sibling-project/file.ts',
					revision: 'v1:loaded',
				})),
				saveText: vi.fn(async () => ({
					success: true as const,
					path: '/workspace/sibling-project/file.ts',
					message: 'saved',
					revision: 'v1:saved',
				})),
				readContent: vi.fn(async () => ({ blob: new Blob(['content']), revision: 'v1:image' })),
			});
			const open = vi.spyOn(fileSessions, 'open');
			const gitSurfaceDeps = createGitSurfaceTestDeps();
			const singletonSurfaces = new SingletonSurfaceRegistry({
				...gitSurfaceDeps,
				createCommit: () => new CommitController(gitSurfaceDeps),
				createPullRequests: () => new PullRequestsStore(),
			});
			const tree = singletonSurfaces.files().tree;
			tree.navigation = {
				kind: 'ready',
				response: {
					fileRootPath: '/workspace',
					homeDirectory: null,
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
			render(FilesPanelTestHost, { presentation });
			await fireEvent.click(screen.getByRole('rowheader', { name: /^file\.ts/ }));

			expect(open).toHaveBeenCalledWith(
				expect.objectContaining({
					fileRootPath: '/workspace',
					relativePath: 'sibling-project/file.ts',
					origin: presentation,
				}),
			);

			await waitFor(() =>
				expect(resolveFileIdentity).toHaveBeenCalledWith({
					projectPath: '/workspace',
					relativePath: 'sibling-project/file.ts',
				}),
			);
		},
	);
});
