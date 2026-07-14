import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import CommitSurfaceTestHost from './CommitSurfaceTestHost.svelte';
import { CommitController } from '$lib/stores/commit.svelte';

function makeController(): CommitController {
	return new CommitController({});
}

describe('CommitSurface', () => {
	it('renders as an in-flow surface without dialog semantics', () => {
		render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'sidebar',
			onOpenFullGit: vi.fn(),
		});

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByRole('button', { name: 'Open Full Git' })).toBeTruthy();
	});

	it('opens the full workbench through its explicit action', async () => {
		const onOpenFullGit = vi.fn();
		render(CommitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'main',
			onOpenFullGit,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Open Full Git' }));
		expect(onOpenFullGit).toHaveBeenCalledOnce();
	});
});
