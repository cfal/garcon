import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import QuickGitSurfaceTestHost from './QuickGitSurfaceTestHost.svelte';
import { QuickGitController } from '$lib/stores/quick-git.svelte';

function makeController(): QuickGitController {
	return new QuickGitController({});
}

describe('QuickGitSurface', () => {
	it('renders as an in-flow surface without dialog semantics', () => {
		render(QuickGitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'sidebar',
			onOpenFullGit: vi.fn(),
		});

		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByRole('button', { name: 'Open Full Git' })).toBeTruthy();
	});

	it('opens the full workbench through its explicit action', async () => {
		const onOpenFullGit = vi.fn();
		render(QuickGitSurfaceTestHost, {
			controller: makeController(),
			presentation: 'main',
			onOpenFullGit,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Open Full Git' }));
		expect(onOpenFullGit).toHaveBeenCalledOnce();
	});
});
