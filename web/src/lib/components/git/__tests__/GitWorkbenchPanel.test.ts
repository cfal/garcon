import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
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
	getOptionalTransientLayers: () => null,
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

function availableProject(projectPath: string) {
	return {
		kind: 'available' as const,
		project: {
			target: { kind: 'chat' as const, chatId: 'chat', projectPath },
			chatId: 'chat',
			projectPath,
			effectiveProjectKey: projectPath,
		},
	};
}

async function readyWorkbench() {
	const controller = new GitWorkbenchSurfaceController(createGitSurfaceTestDeps());
	vi.spyOn(controller.target, 'ensureTargets').mockResolvedValue(false);
	vi.spyOn(controller.workbench, 'refresh').mockResolvedValue();
	vi.spyOn(controller.workbench, 'checkFreshness').mockResolvedValue();
	vi.spyOn(controller.repository, 'fetchRemoteStatus').mockResolvedValue();
	controller.setProjectState(availableProject('/project'));
	controller.setPresentationVisible(true);
	await controller.target.activate();
	return controller;
}

describe('GitWorkbenchPanel', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it.each(['stay', 'hide', 'hide and return', 'unmount', 'checkout', 'completed checkout'])(
		'only opens Push in its original visit: %s',
		async (change) => {
			const controller = await readyWorkbench();
			const remotes = Promise.withResolvers<typeof controller.repository.pushRemotes>();
			const prepare = vi
				.spyOn(controller.repository, 'loadPushRemotes')
				.mockReturnValue(remotes.promise);
			const props = { controller, presentation: 'window-main' as const };
			const view = render(GitWorkbenchPanel, props);
			await fireEvent.click(screen.getByRole('button', { name: 'Push' }));
			expect(prepare).toHaveBeenCalledOnce();
			if (change === 'checkout' || change === 'completed checkout') {
				controller.target.branchChangePending = true;
				if (change === 'completed checkout') {
					await tick();
					controller.repository.currentBranch = 'next';
					controller.target.branchChangePending = false;
				}
			} else if (change === 'unmount') {
				view.unmount();
			} else if (change !== 'stay') {
				await view.rerender({ ...props, visible: false });
				if (change === 'hide and return') await view.rerender({ ...props, visible: true });
			}
			const fetched = [{ name: 'backup', url: '/repos/backup' }];
			remotes.resolve(fetched);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(controller.repository.showPushModal).toBe(change === 'stay');
			expect(controller.repository.pushRemotes).toEqual(change === 'stay' ? fetched : []);
			controller.dispose();
		},
	);

	it('keeps the chosen push remote when the owning tab is hidden and shown', async () => {
		const controller = await readyWorkbench();
		controller.repository.pushRemotes = ['origin', 'backup'].map((name) => ({
			name,
			url: `/repos/${name}`,
		}));
		controller.repository.showPushModal = true;
		const props = { controller, presentation: 'window-main' as const };
		const view = render(GitWorkbenchPanel, props);
		try {
			await fireEvent.click(await screen.findByRole('radio', { name: /backup/ }));
			await view.rerender({ ...props, visible: false });
			expect(screen.queryByRole('dialog')).toBeNull();
			await view.rerender({ ...props, visible: true });
			expect(await screen.findByRole('radio', { name: /backup/, checked: true })).toBeTruthy();
		} finally {
			controller.dispose();
		}
	});

	it.each([false, true])(
		'submits only the confirmed branch while ready (checkout=%s)',
		async (checkout) => {
			const controller = await readyWorkbench();
			controller.repository.currentBranch = 'main';
			controller.repository.pushRemotes = [{ name: 'origin', url: '/repos/origin' }];
			controller.repository.showPushModal = true;
			const dispatch = vi.spyOn(controller.repository, 'handlePush').mockResolvedValue(false);
			render(GitWorkbenchPanel, { controller, presentation: 'window-main' });
			const dialog = await screen.findByRole('dialog');
			controller.target.branchChangePending = checkout;
			await fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true });
			if (checkout) expect(dispatch).not.toHaveBeenCalled();
			else
				expect(dispatch).toHaveBeenCalledWith(
					expect.objectContaining({ executorId: 'local', projectPath: '/project' }),
					'origin',
					'main',
				);
			controller.dispose();
		},
	);

	it('hides portaled Git actions until the replacement project is applied', async () => {
		const controller = await readyWorkbench();
		controller.repository.showPushModal = true;
		controller.workbench.drafts.openCommentComposer('first.ts', 'after', 1);
		render(GitWorkbenchPanel, { controller, presentation: 'mobile' });
		expect(await screen.findByRole('dialog')).toBeTruthy();
		const replacement = Promise.withResolvers<boolean>();
		vi.mocked(controller.target.ensureTargets).mockReturnValue(replacement.promise);
		controller.setProjectState(availableProject('/replacement'));
		await tick();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByTestId('git-compare-panel-content').dataset.active).toBe('false');
		replacement.resolve(false);
		await controller.target.activate();
		expect(controller.repository.showPushModal).toBe(false);
		expect(controller.workbench.drafts.commentComposer.open).toBe(false);
		controller.dispose();
	});

	it.each([
		['window-main', '/other'],
		['mobile', '/other'],
		['window-main', '/project'],
		['mobile', '/project'],
	] as const)(
		'opens a busy Commit without changing its project (%s, %s)',
		async (presentation, projectPath) => {
			const deps = createGitSurfaceTestDeps();
			const commit = new CommitController(deps);
			harness.commit = commit;
			commit.setProjectState({
				kind: 'available',
				project: {
					target: { kind: 'chat' as const, chatId: 'other', projectPath: projectPath },
					chatId: 'other',
					projectPath,
					effectiveProjectKey: projectPath,
				},
			});
			commit.message = 'Retained draft';
			commit.isGeneratingMessage = true;
			const controller = new GitWorkbenchSurfaceController(deps);
			controller.setProjectState({
				kind: 'available',
				project: {
					target: { kind: 'chat' as const, chatId: 'chat', projectPath: '/project' },
					chatId: 'chat',
					projectPath: '/project',
					effectiveProjectKey: '/project',
				},
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
