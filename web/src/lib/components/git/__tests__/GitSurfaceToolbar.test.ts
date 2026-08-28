import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitSurfaceToolbarTestHost from './GitSurfaceToolbarTestHost.svelte';
import { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';
import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';

vi.mock('$lib/api/git.js', () => ({
	getGitTargetCandidates: vi.fn().mockResolvedValue({ targets: [] }),
	getGitRefs: vi.fn().mockResolvedValue({ refs: [] }),
	getGitWorktrees: vi.fn().mockResolvedValue({ worktrees: [] }),
}));

function target(): GitTargetSessionController {
	const controller = new GitTargetSessionController({
		kind: 'git-history',
		createBranchSelector: () => new GitBranchSelectorState(),
		invalidationVersion: () => 0,
		canChangeTarget: () => true,
		onTargetChanged: () => undefined,
	});
	controller.setProjectState({
		kind: 'available',
		project: {
			chatId: 'chat',
			projectPath: '/very/long/workspace/project/path',
			effectiveProjectKey: 'chat',
		},
	});
	return controller;
}

afterEach(cleanup);

describe('GitSurfaceToolbar', () => {
	it('exposes the full target path while visually truncating it', () => {
		render(GitSurfaceToolbarTestHost, {
			props: {
				target: target(),
				presentation: 'pane-sidebar',
			},
		});
		const folder = screen.getByRole('button', {
			name: '/very/long/workspace/project/path',
		});

		expect(folder.getAttribute('title')).toBe('/very/long/workspace/project/path');
		expect(folder.textContent).toContain('...');
		expect(screen.getByRole('button', { name: /current ref HEAD/i })).toBeTruthy();
	});

	it('expands the branch control on wide screens without wrapping on narrow screens', () => {
		const longBranch = 'feature/a-long-current-branch-name';
		const controller = target();
		controller.branches.currentBranch = longBranch;
		render(GitSurfaceToolbarTestHost, {
			props: {
				target: controller,
				presentation: 'pane-main',
			},
		});

		const trigger = screen.getByRole('button', {
			name: new RegExp(`current ref ${longBranch}`, 'i'),
		});
		const label = within(trigger).getByText(longBranch);
		expect(trigger.className).toContain('max-w-40');
		expect(trigger.className).toContain('sm:max-w-80');
		expect(label.className).toContain('max-w-24');
		expect(label.className).toContain('sm:max-w-64');
		expect(label.className).toContain('truncate');
	});

	it('forwards branch sort intent with the current query', async () => {
		const controller = target();
		controller.branches.refs = [
			{
				name: 'feature/sort',
				ref: 'refs/heads/feature/sort',
				kind: 'local-branch',
				updatedAt: null,
			},
		];
		controller.branches.showBranchDropdown = true;
		const toggleBranchSort = vi
			.spyOn(controller.branches, 'toggleBranchSort')
			.mockResolvedValue(undefined);
		render(GitSurfaceToolbarTestHost, {
			props: {
				target: controller,
				presentation: 'pane-main',
			},
		});

		await fireEvent.input(screen.getByRole('combobox', { name: 'Find a ref' }), {
			target: { value: 'feature' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Sort by Updated, newest first' }));

		expect(toggleBranchSort).toHaveBeenCalledWith(
			'/very/long/workspace/project/path',
			'updated',
			'feature',
		);
	});

	it('opens the shared target dialog from the folder control', async () => {
		render(GitSurfaceToolbarTestHost, {
			props: {
				target: target(),
				presentation: 'pane-main',
			},
		});

		await fireEvent.click(
			screen.getByRole('button', {
				name: '/very/long/workspace/project/path',
			}),
		);
		expect(screen.getByRole('dialog', { name: m.git_target() })).toBeTruthy();
	});

	it('renders Close only on mobile and keeps it last in toolbar order', async () => {
		const onClose = vi.fn();
		const rendered = render(GitSurfaceToolbarTestHost, {
			props: {
				target: target(),
				presentation: 'mobile',
				onClose,
			},
		});
		const toolbar = rendered.container.querySelector('[data-git-surface-toolbar]');
		const close = screen.getByRole('button', { name: m.workspace_close_view() });

		expect(toolbar?.lastElementChild).toBe(close);
		await fireEvent.click(close);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('disables mobile Close during the owning mutation and omits it on desktop', async () => {
		const onClose = vi.fn();
		const rendered = render(GitSurfaceToolbarTestHost, {
			props: {
				target: target(),
				presentation: 'mobile',
				onClose,
				closeDisabled: true,
			},
		});
		expect(
			screen.getByRole('button', { name: m.workspace_close_view() }).hasAttribute('disabled'),
		).toBe(true);

		await rendered.rerender({
			target: target(),
			presentation: 'pane-sidebar',
			onClose,
			closeDisabled: false,
		});
		expect(screen.queryByRole('button', { name: m.workspace_close_view() })).toBeNull();
	});

	it('places persistent Git controls in the responsive action menu', async () => {
		render(GitSurfaceToolbarTestHost, {
			props: {
				target: target(),
				presentation: 'pane-main',
				showMenuLeadingContent: true,
			},
		});

		expect(screen.getAllByRole('button', { name: m.git_more_actions() })).toHaveLength(1);
		await fireEvent.click(screen.getByRole('button', { name: m.git_more_actions() }));
		expect(document.querySelector('[data-test-diff-settings]')).toBeTruthy();
	});
});
