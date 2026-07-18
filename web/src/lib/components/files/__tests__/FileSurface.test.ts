import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FileSurfaceTestHost from './FileSurfaceTestHost.svelte';

afterEach(cleanup);

describe('FileSurface', () => {
	it('hides File Sessions from mobile file chrome', () => {
		const { container } = render(FileSurfaceTestHost, { presentation: 'mobile' });

		expect(container.querySelector('[data-surface-action-measure="open-files"]')).toBeNull();
	});

	it('retains File Sessions in desktop file chrome', () => {
		const { container } = render(FileSurfaceTestHost, { presentation: 'main' });

		expect(container.querySelector('[data-surface-action-measure="open-files"]')).not.toBeNull();
	});

	it.each(['code', 'markdown', 'image'] as const)(
		'exposes Refresh for the %s renderer',
		(rendererMode) => {
			const { container } = render(FileSurfaceTestHost, {
				presentation: 'main',
				rendererMode,
			});

			expect(container.querySelector('[data-surface-action-measure="refresh-file"]')).not.toBeNull();
		},
	);

	it('refreshes from the stale banner without replacing current content', async () => {
		const onRefresh = vi.fn();
		render(FileSurfaceTestHost, {
			presentation: 'main',
			rendererMode: 'markdown',
			loading: false,
			stale: true,
			onRefresh,
		});

		expect(screen.getByText('Heading')).toBeTruthy();
		const message = screen.getByText(/This file changed on disk/);
		const banner = message.closest<HTMLElement>('[data-refresh-required-banner]');
		if (!banner) throw new Error('Expected refresh banner');
		await fireEvent.click(within(banner).getByRole('button', { name: 'Refresh' }));
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('keeps the toolbar Refresh action focusable while busy', () => {
		render(FileSurfaceTestHost, {
			presentation: 'main',
			loading: false,
			refreshing: true,
		});

		const refresh = screen.getByRole('button', { name: 'Refresh' });
		expect(refresh.getAttribute('aria-busy')).toBe('true');
		expect(refresh.getAttribute('aria-disabled')).toBe('true');
		expect((refresh as HTMLButtonElement).disabled).toBe(false);
	});

	it('disables Save while a refresh is pending', () => {
		render(FileSurfaceTestHost, {
			presentation: 'main',
			rendererMode: 'code',
			loading: false,
			refreshing: true,
			dirty: true,
		});

		expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it('refreshes from the toolbar action', async () => {
		const onRefresh = vi.fn();
		render(FileSurfaceTestHost, {
			presentation: 'main',
			loading: false,
			onRefresh,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('checks freshness immediately when the surface mounts', async () => {
		const onCheckFreshness = vi.fn();
		render(FileSurfaceTestHost, {
			presentation: 'main',
			onCheckFreshness,
		});

		await waitFor(() => expect(onCheckFreshness).toHaveBeenCalledOnce());
	});
});
