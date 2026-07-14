import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TerminalSurfaceTestHost from './TerminalSurfaceTestHost.svelte';
import { ApiError } from '$lib/api/client';

describe('TerminalSurface', () => {
	it('labels the terminal path as its initial directory rather than its current directory', () => {
		render(TerminalSurfaceTestHost, { host: 'main' });

		expect(screen.getByText('Started in /workspace/project')).toBeTruthy();
	});

	it('shows input helpers on a coarse-pointer desktop', () => {
		const originalMatchMedia = window.matchMedia;
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			value: vi.fn(() => ({
				matches: true,
				media: '(pointer: coarse)',
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			})),
		});
		try {
			render(TerminalSurfaceTestHost, { host: 'main' });
			expect(screen.getByRole('button', { name: 'Ctrl' })).toBeTruthy();
		} finally {
			Object.defineProperty(window, 'matchMedia', {
				configurable: true,
				value: originalMatchMedia,
			});
		}
	});

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

	it('switches the current terminal tab instead of opening another tab', async () => {
		const onSwitch = vi.fn();
		render(TerminalSurfaceTestHost, { host: 'main', onSwitch });

		await fireEvent.change(screen.getByRole('combobox', { name: 'Terminal session' }), {
			target: { value: 'terminal-2' },
		});

		expect(onSwitch).toHaveBeenCalledWith('terminal-1', 'terminal-2');
	});

	it('creates a terminal by replacing the current terminal tab', async () => {
		const onCreateReplacing = vi.fn();
		render(TerminalSurfaceTestHost, { host: 'main', onCreateReplacing });

		await fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));

		expect(onCreateReplacing).toHaveBeenCalledWith('terminal-1');
	});
});
