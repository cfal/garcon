import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import CommitSurfaceTestHost from './CommitSurfaceTestHost.svelte';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import type { GitTreeNode } from '$lib/api/git.js';
import * as m from '$lib/paraglide/messages.js';

function makeController(): CommitController {
	const controller = new CommitController(createGitSurfaceTestDeps());
	void controller.setContext('/project', '/project');
	return controller;
}

function installTree(controller: CommitController, tree: GitTreeNode[]): void {
	controller.tree = tree;
	controller.intents = Object.fromEntries(
		tree
			.flatMap((node) => node.children ?? [node])
			.filter((node) => node.kind === 'file')
			.map((node) => [
				node.path,
				{
					path: node.path,
					desiredSelected: node.staged,
					actualSelected: node.staged,
					isRunning: false,
					runningMode: null,
					error: null,
				},
			]),
	);
}

describe('CommitSurface', () => {
	it('renders as an in-flow surface without dialog semantics', () => {
		render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'pane-sidebar',
		});

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Open Full Git' })).toBeNull();
		expect(screen.getByRole('button', { name: m.filetree_refresh_files() })).toBeTruthy();
	});

	it('marks the commit message as the primary focus target', () => {
		render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'pane-sidebar',
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
			presentation: 'pane-main',
		});

		const folder = screen.getByRole('button', { name: '/project' });
		const toolbar = container.querySelector('[data-git-surface-toolbar]');
		expect(toolbar?.querySelector('button')).toBe(folder);
		expect(screen.getByRole('button', { name: /current ref HEAD/i })).toBeTruthy();
	});

	it('places the selected-file summary between the file tree and commit message', () => {
		const { container } = render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'pane-main',
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

	it('bounds mounted rows while allowing a large tree to reach its final file', async () => {
		const controller = makeController();
		const fileCount = 80;
		const children: GitTreeNode[] = Array.from({ length: fileCount }, (_, index) => ({
			path: `src/file-${index.toString().padStart(4, '0')}.ts`,
			name: `file-${index.toString().padStart(4, '0')}.ts`,
			kind: 'file',
			staged: false,
			hasUnstaged: true,
			changeKind: 'modified',
			additions: 1,
			deletions: 0,
		}));
		installTree(controller, [
			{
				path: 'src',
				name: 'src',
				kind: 'directory',
				staged: false,
				hasUnstaged: true,
				children,
				additions: fileCount,
				deletions: 0,
			},
		]);

		const { container } = render(CommitSurfaceTestHost, {
			controller,
			presentation: 'pane-sidebar',
		});
		const viewport = container.querySelector<HTMLElement>('[data-commit-file-scroll]');
		expect(viewport).toBeTruthy();
		if (!viewport) return;

		const mountedCheckboxes = () =>
			viewport.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		expect(mountedCheckboxes().length).toBeLessThan(50);
		expect(viewport.querySelector('[title="src/file-0079.ts"]')).toBeNull();

		viewport.scrollTop = fileCount * 28;
		await fireEvent.scroll(viewport);
		await tick();

		expect(mountedCheckboxes().length).toBeLessThan(50);
		expect(viewport.querySelector('[title="src/file-0079.ts"]')).toBeTruthy();
	});

	it('preserves directory and file selection actions in the virtual tree', async () => {
		const controller = makeController();
		installTree(controller, [
			{
				path: 'src',
				name: 'src',
				kind: 'directory',
				staged: false,
				hasUnstaged: true,
				children: [
					{
						path: 'src/file.ts',
						name: 'file.ts',
						kind: 'file',
						staged: false,
						hasUnstaged: true,
					},
				],
			},
		]);
		const toggleDirectory = vi.spyOn(controller, 'toggleDirectory');
		const togglePath = vi.spyOn(controller, 'togglePath');
		const { container } = render(CommitSurfaceTestHost, {
			controller,
			presentation: 'pane-sidebar',
		});
		const checkboxes = container.querySelectorAll<HTMLInputElement>(
			'[data-commit-file-scroll] input[type="checkbox"]',
		);
		expect(checkboxes).toHaveLength(2);

		await fireEvent.click(checkboxes[0] as HTMLInputElement);
		await fireEvent.click(checkboxes[1] as HTMLInputElement);

		expect(toggleDirectory).toHaveBeenCalledWith('src', true);
		expect(togglePath).toHaveBeenCalledWith('src/file.ts', true);
	});

	it('owns branch state independently from another Commit controller', () => {
		const first = makeController();
		const second = makeController();
		first.target.branches.currentBranch = 'feature';

		expect(second.target.branches.currentBranch).toBe('');
		expect(first.target.branches).not.toBe(second.target.branches);
	});
});
