import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitCompareSurfaceController } from '$lib/git/review/git-compare-surface.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import GitComparePanel from '../GitComparePanel.svelte';

const context = vi.hoisted(() => ({
	openTransient: vi.fn((_layer: string, open: () => void) => open()),
}));

vi.mock('$lib/context', () => ({
	getFileSessions: () => ({ open: vi.fn() }),
	getLocalSettings: () => ({ gitDiffFontSize: '12' }),
	getTransientLayers: () => ({ open: context.openTransient }),
	getWorkspaceCoordinator: () => ({
		closeSurface: vi.fn().mockResolvedValue(true),
		focusChat: vi.fn().mockResolvedValue(undefined),
		isSurfaceCloseBlocked: () => false,
	}),
}));

vi.mock('../GitCompareToolbar.svelte', async () => ({
	default: (await import('./GitComparePanelToolbarStub.svelte')).default,
}));

vi.mock('../GitComparisonScreen.svelte', async () => ({
	default: (await import('./GitComparePanelContentStub.svelte')).default,
}));

vi.mock('../GitComparisonDialog.svelte', async () => ({
	default: (await import('./GitComparePanelContentStub.svelte')).default,
}));

describe('GitComparePanel', () => {
	afterEach(cleanup);

	it('reloads Name-sorted refs every time comparison editing opens', async () => {
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		controller.setProjectState({
			kind: 'available',
			project: {
				chatId: 'chat',
				projectPath: '/project',
				effectiveProjectKey: '/project',
			},
		});
		controller.target.branches.refs = [
			{
				name: 'already-loaded',
				ref: 'refs/heads/already-loaded',
				kind: 'local-branch',
				updatedAt: null,
			},
		];
		const fetchRefs = vi
			.spyOn(controller.target.branches, 'fetchRefs')
			.mockResolvedValue(undefined);

		render(GitComparePanel, {
			controller,
			presentation: 'main',
			visible: false,
		});

		const edit = screen.getByRole('button', { name: 'Edit comparison' });
		await fireEvent.click(edit);
		await fireEvent.click(edit);

		expect(fetchRefs).toHaveBeenCalledTimes(2);
		expect(fetchRefs).toHaveBeenNthCalledWith(1, '/project');
		expect(fetchRefs).toHaveBeenNthCalledWith(2, '/project');
	});
});
