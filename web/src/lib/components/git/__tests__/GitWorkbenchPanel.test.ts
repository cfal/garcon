import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { GitWorkbenchSurfaceController } from '$lib/git/workbench/git-workbench-surface.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import GitWorkbenchPanel from '../GitWorkbenchPanel.svelte';

const harness = vi.hoisted(() => ({
	commit: null as CommitController | null,
	openSingletonAsTab: vi.fn(async () => {}),
	focusMobileSingleton: vi.fn(async () => {}),
	info: vi.fn(),
}));

vi.mock('$lib/context', () => ({
	getFileSessions: () => ({ open: vi.fn() }),
	getLocalSettings: () => ({ gitDiffFontSize: '12' }),
	getNotifications: () => ({ info: harness.info, error: vi.fn() }),
	getSingletonSurfaces: () => ({ commit: () => harness.commit }),
	getTransientLayers: () => ({ open: vi.fn() }),
	getWorkspaceShortcuts: () => ({ registerSurface: () => () => {} }),
	getWorkspaceCoordinator: () => ({
		openSingletonAsTab: harness.openSingletonAsTab,
		focusMobileSingleton: harness.focusMobileSingleton,
		closeSurface: vi.fn(async () => true),
		isSurfaceCloseBlocked: () => false,
	}),
}));

vi.mock('../GitWorkbenchToolbar.svelte', async () => ({
	default: (await import('./GitWorkbenchPanelToolbarStub.svelte')).default,
}));
vi.mock('../GitWorkbench.svelte', async () => ({
	default: (await import('./GitComparePanelContentStub.svelte')).default,
}));

describe('GitWorkbenchPanel Commit navigation', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it.each([
		['window-main', '/other'], ['mobile', '/other'],
		['window-main', '/project'], ['mobile', '/project'],
	] as const)(
		'opens a busy Commit without changing its project (%s, %s)',
		async (presentation, projectPath) => {
			const deps = createGitSurfaceTestDeps();
			const commit = new CommitController(deps);
			harness.commit = commit;
			commit.setProjectState({
				kind: 'available',
				project: { chatId: 'other', projectPath, effectiveProjectKey: projectPath },
			});
			commit.message = 'Retained draft';
			commit.isGeneratingMessage = true;
			const controller = new GitWorkbenchSurfaceController(deps);
			controller.setProjectState({
				kind: 'available',
				project: { chatId: 'chat', projectPath: '/project', effectiveProjectKey: '/project' },
			});
			vi.spyOn(controller.target, 'canChangeTarget', 'get').mockReturnValue(true);
			render(GitWorkbenchPanel, { controller, presentation, visible: false });

			await fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

			expect(
				presentation === 'mobile' ? harness.focusMobileSingleton : harness.openSingletonAsTab,
			).toHaveBeenCalledOnce();
			expect(commit.target.requestTarget).toEqual({ executorId: 'local', projectPath });
			expect(commit.message).toBe('Retained draft');
			expect(commit.isGeneratingMessage).toBe(true);
			expect(harness.info).toHaveBeenCalledTimes(projectPath === '/project' ? 0 : 1);
			controller.dispose();
			commit.dispose();
		},
	);
});
