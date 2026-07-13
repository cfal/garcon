import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TerminalSurfaceTestHost from './TerminalSurfaceTestHost.svelte';

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
});
