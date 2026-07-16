import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CommitSurfaceTestHost from './CommitSurfaceTestHost.svelte';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import * as m from '$lib/paraglide/messages.js';

function makeController(): CommitController {
	return new CommitController({});
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
});
