import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CommitSurfaceTestHost from './CommitSurfaceTestHost.svelte';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import * as m from '$lib/paraglide/messages.js';

function makeController(): CommitController {
	const controller = new CommitController(createGitSurfaceTestDeps());
	void controller.setContext('/project', '/project');
	return controller;
}

describe('CommitSurface', () => {
	it('renders as an in-flow surface without dialog semantics', () => {
		render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'sidebar',
		});

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Open Full Git' })).toBeNull();
		expect(screen.getByRole('button', { name: m.filetree_refresh_files() })).toBeTruthy();
	});

	it('marks the commit message as the primary focus target', () => {
		render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'sidebar',
		});

		expect(screen.getByRole('textbox').hasAttribute('data-surface-primary')).toBe(true);
	});

	it('keeps the mobile commit message large enough to avoid iPhone focus zoom', () => {
		render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'mobile',
		});

		expect(screen.getByRole('textbox').classList.contains('text-base')).toBe(true);
	});

	it('uses the shared folder and branch target controls', () => {
		const { container } = render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'main',
		});

		const folder = screen.getByRole('button', { name: '/project' });
		const toolbar = container.querySelector('[data-git-surface-toolbar]');
		expect(toolbar?.querySelector('button')).toBe(folder);
		expect(screen.getByRole('button', { name: /current ref HEAD/i })).toBeTruthy();
	});

	it('places the selected-file summary between the file tree and commit message', () => {
		const { container } = render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'main',
		});

		const toolbar = container.querySelector('[data-git-surface-toolbar]');
		const tree = container.querySelector('[data-commit-file-tree]');
		const fileScroll = container.querySelector<HTMLElement>('[data-commit-file-scroll]');
		const summary = container.querySelector('[data-commit-selection-summary]');
		const message = screen.getByRole('textbox');
		expect(summary?.textContent).toContain(m.git_quick_commit_select_files());
		expect(toolbar?.contains(summary)).toBe(false);
		expect(tree).toBeTruthy();
		expect(fileScroll?.dataset.workspaceScrollRegion).toBe('primary');
		expect(summary).toBeTruthy();
		if (!tree || !summary) return;
		expect(tree.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(
			summary.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it('owns branch state independently from another Commit controller', () => {
		const first = makeController();
		const second = makeController();
		first.target.branches.currentBranch = 'feature';

		expect(second.target.branches.currentBranch).toBe('');
		expect(first.target.branches).not.toBe(second.target.branches);
	});
});
