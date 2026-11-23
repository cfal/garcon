import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import * as gitApi from '$lib/api/git.js';
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
	controller.repository.currentBranch = 'main';
	controller.repository.remoteStatus = {
		hasRemote: true,
		hasUpstream: false,
		branch: 'main',
		remoteName: 'origin',
	};
	return controller;
}

async function openPush() {
	vi.spyOn(gitApi, 'getGitRemotes').mockResolvedValue({
		remotes: ['origin', 'backup'].map((name) => ({ name, url: `/repos/${name}` })),
	});
	await fireEvent.click(screen.getByRole('button', { name: 'Push' }));
	return screen.findByRole('dialog', { name: 'Push to remote' });
}

describe('GitWorkbenchPanel', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it.each([
		'stay',
		'hide',
		'hide and return',
		'unmount',
		'checkout',
		'completed checkout',
		'external checkout',
		'external checkout and return',
		'conflicting remote status and return',
	])('only opens Push in its original visit: %s', async (change) => {
		const controller = await readyWorkbench();
		const remotes = Promise.withResolvers<Awaited<ReturnType<typeof gitApi.getGitRemotes>>>();
		const prepare = vi.spyOn(gitApi, 'getGitRemotes').mockReturnValue(remotes.promise);
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
		} else if (change === 'conflicting remote status and return') {
			controller.repository.remoteStatus!.branch = 'next';
			await tick();
			controller.repository.remoteStatus!.branch = 'main';
		} else if (change.startsWith('external checkout')) {
			// History publishes the branch without starting a checkout in this panel.
			controller.repository.currentBranch = 'next';
			if (change === 'external checkout and return') {
				await tick();
				controller.repository.currentBranch = 'main';
			}
		} else if (change === 'unmount') {
			view.unmount();
		} else if (change !== 'stay') {
			await view.rerender({ ...props, visible: false });
			if (change === 'hide and return') await view.rerender({ ...props, visible: true });
		}
		const fetched = [{ name: 'backup', url: '/repos/backup' }];
		remotes.resolve({ remotes: fetched });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(controller.repository.pushPrompt).toEqual(
			change === 'stay'
				? {
						project: { executorId: 'local', projectPath: '/project' },
						branch: 'main',
						remotes: fetched,
						selectedRemote: 'backup',
					}
				: null,
		);
		controller.dispose();
	});

	it.each(['hide', 'unmount'])(
		'requires a fresh Push click after the presenter leaves (%s)',
		async (exit) => {
			const controller = await readyWorkbench();
			const props = { controller, presentation: 'window-main' as const };
			const view = render(GitWorkbenchPanel, props);
			try {
				await openPush();
				await fireEvent.click(await screen.findByRole('radio', { name: /backup/ }));
				if (exit === 'hide') await view.rerender({ ...props, visible: false });
				else view.unmount();
				expect(screen.queryByRole('dialog')).toBeNull();
				if (exit === 'hide') await view.rerender({ ...props, visible: true });
				else render(GitWorkbenchPanel, props);
				expect(screen.queryByRole('dialog')).toBeNull();
				await fireEvent.click(screen.getByRole('button', { name: 'Push' }));
				expect(await screen.findByRole('radio', { name: /origin/, checked: true })).toBeTruthy();
				expect(gitApi.getGitRemotes).toHaveBeenCalledTimes(2);
			} finally {
				controller.dispose();
			}
		},
	);

	it('discards an open Push prompt after a branch change', async () => {
		const controller = await readyWorkbench();
		const props = { controller, presentation: 'window-main' as const };
		render(GitWorkbenchPanel, props);
		await openPush();
		controller.repository.currentBranch = 'next';
		await tick();
		expect(screen.queryByRole('dialog')).toBeNull();
		controller.repository.currentBranch = 'main';
		await tick();
		expect(screen.queryByRole('dialog')).toBeNull();
		controller.dispose();
	});

	it.each([false, true])(
		'submits only the confirmed branch while ready (checkout=%s)',
		async (checkout) => {
			const controller = await readyWorkbench();
			const dispatch = vi.spyOn(controller.repository, 'handlePush').mockResolvedValue(false);
			render(GitWorkbenchPanel, { controller, presentation: 'window-main' });
			const dialog = await openPush();
			await fireEvent.click(screen.getByRole('radio', { name: /backup/ }));
			controller.target.branchChangePending = checkout;
			// Dispatch before Svelte removes the prompt; a detached dialog cannot receive user input.
			dialog.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
			);
			await tick();
			if (checkout) {
				expect(dispatch).not.toHaveBeenCalled();
				controller.target.branchChangePending = false;
				await tick();
				expect(screen.queryByRole('dialog')).toBeNull();
			} else {
				expect(dispatch).toHaveBeenCalledWith(
					expect.objectContaining({ executorId: 'local', projectPath: '/project' }),
					'backup',
					'main',
				);
			}
			controller.dispose();
		},
	);

	it('hides portaled Git actions until the replacement project is applied', async () => {
		const controller = await readyWorkbench();
		controller.workbench.drafts.openCommentComposer('first.ts', 'after', 1);
		render(GitWorkbenchPanel, { controller, presentation: 'mobile' });
		await openPush();
		const replacement = Promise.withResolvers<boolean>();
		vi.mocked(controller.target.ensureTargets).mockReturnValue(replacement.promise);
		controller.setProjectState(availableProject('/replacement'));
		await tick();
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByTestId('git-compare-panel-content').dataset.active).toBe('false');
		replacement.resolve(false);
		await controller.target.activate();
		expect(controller.repository.pushPrompt).toBeNull();
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
