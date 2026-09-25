import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHistorySurfaceController } from '$lib/git/history/git-history-surface.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import GitHistoryPanel from '../GitHistoryPanel.svelte';

vi.mock('$lib/context', () => ({
	getFileSessions: () => ({ open: vi.fn() }),
	getLocalSettings: () => ({ gitDiffFontSize: '12' }),
	getGitReviewDisplay: () => ({ diffMode: 'unified', contextLines: 3 }),
	getTransientLayers: () => ({ open: vi.fn() }),
	getWorkspaceShortcuts: () => ({ registerSurface: () => () => {} }),
	getWorkspaceCoordinator: () => ({
		closeSurface: vi.fn().mockResolvedValue(true),
		focusChat: vi.fn().mockResolvedValue(undefined),
		isSurfaceCloseBlocked: () => false,
	}),
}));

vi.mock('../GitHistoryToolbar.svelte', async () => ({
	default: (await import('./GitHistoryPanelToolbarStub.svelte')).default,
}));

vi.mock('../GitHistoryView.svelte', async () => ({
	default: (await import('./GitComparePanelContentStub.svelte')).default,
}));

describe('GitHistoryPanel refresh', () => {
	afterEach(cleanup);

	it.each(['list', 'commit'] as const)(
		'refreshes target metadata from the %s screen',
		async (historyScreen) => {
			const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
			controller.setProjectState({
				kind: 'available',
				project: {
					chatId: 'chat',
					executorId: 'remote',
					projectPath: '/project',
					effectiveProjectKey: '/project',
				},
			});
			controller.history.screen = historyScreen;
			vi.spyOn(controller.target, 'canChangeTarget', 'get').mockReturnValue(true);
			const refresh = vi.spyOn(controller.target, 'refreshTargets').mockResolvedValue(undefined);
			render(GitHistoryPanel, { controller, presentation: 'window-main', visible: false });

			await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

			expect(refresh).toHaveBeenCalledExactlyOnceWith('session');
			expect(controller.history.screen).toBe(historyScreen);
			controller.dispose();
		},
	);

	it('rejects refresh while the project identity is pending', async () => {
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		controller.target.projectIdentityPending = true;
		const refresh = vi.spyOn(controller.target, 'refreshTargets').mockResolvedValue(undefined);
		render(GitHistoryPanel, { controller, presentation: 'window-main', visible: false });

		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

		expect(refresh).not.toHaveBeenCalled();
		controller.dispose();
	});
});
