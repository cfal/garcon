import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CommitSurfaceTestHost from './CommitSurfaceTestHost.svelte';
import { CommitController } from '$lib/stores/commit.svelte';
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
});
