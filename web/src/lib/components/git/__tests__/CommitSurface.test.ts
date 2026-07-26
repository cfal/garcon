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
		render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'main',
		});

		expect(screen.getByRole('button', { name: '/project' })).toBeTruthy();
		expect(screen.getByRole('button', { name: /current ref HEAD/i })).toBeTruthy();
	});

	it('owns branch state independently from another Commit controller', () => {
		const first = makeController();
		const second = makeController();
		first.target.branches.currentBranch = 'feature';

		expect(second.target.branches.currentBranch).toBe('');
		expect(first.target.branches).not.toBe(second.target.branches);
	});
});
