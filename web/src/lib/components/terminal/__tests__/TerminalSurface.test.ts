import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TerminalSurfaceTestHost from './TerminalSurfaceTestHost.svelte';
import { ApiError } from '$lib/api/client';

describe('TerminalSurface', () => {
	it('shows input helpers and guarded session Close only in mobile presentation', async () => {
		const onClose = vi.fn();
		const onModifier = vi.fn();
		const onToolbarKey = vi.fn();
		const { rerender } = render(TerminalSurfaceTestHost, {
			host: 'main',
			onClose,
			onModifier,
			onToolbarKey,
		});

		expect(screen.queryByRole('button', { name: 'Ctrl' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Close terminal session' })).toBeNull();

		await rerender({ host: 'mobile', onClose, onModifier, onToolbarKey });
		await fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Close terminal session' }));

		expect(onModifier).toHaveBeenCalledWith('ctrl');
		expect(onToolbarKey).toHaveBeenCalledWith('escape');
		expect(onClose).toHaveBeenCalledWith('terminal:terminal-1');
	});

	it('focuses the session picker when the server reports the terminal cap', async () => {
		render(TerminalSurfaceTestHost, {
			host: 'main',
			createError: new ApiError(409, 'Limit reached', 'terminal-limit'),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
		await Promise.resolve();
		expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Terminal session' }));
	});
});
