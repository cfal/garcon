import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkspaceFullscreenButtonTestHost from './WorkspaceFullscreenButtonTestHost.svelte';

describe('WorkspaceFullscreenButton', () => {
	afterEach(cleanup);

	it.each(['main', 'sidebar'] as const)('targets the %s host', async (host) => {
		const onToggleFullscreen = vi.fn();
		render(WorkspaceFullscreenButtonTestHost, {
			host,
			onToggleFullscreen,
		});

		const button = screen.getByRole('button', { name: 'Fullscreen' });
		expect(button.getAttribute('data-workspace-fullscreen-toggle')).toBe(host);
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(button.getAttribute('title')).toBe('Fullscreen');
		expect(button.querySelector('.lucide-maximize-2')).toBeTruthy();

		await fireEvent.click(button);
		expect(onToggleFullscreen).toHaveBeenCalledWith(host);
	});

	it('shows the exit state only for the fullscreen host', () => {
		const onToggleFullscreen = vi.fn();
		const { unmount } = render(WorkspaceFullscreenButtonTestHost, {
			host: 'sidebar',
			fullscreenHost: 'sidebar',
			onToggleFullscreen,
		});

		const exit = screen.getByRole('button', { name: 'Exit fullscreen' });
		expect(exit.getAttribute('aria-pressed')).toBe('true');
		expect(exit.getAttribute('title')).toBe('Exit fullscreen');
		expect(exit.querySelector('.lucide-minimize-2')).toBeTruthy();

		unmount();
		render(WorkspaceFullscreenButtonTestHost, {
			host: 'main',
			fullscreenHost: 'sidebar',
			onToggleFullscreen,
		});
		expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeTruthy();
	});
});
