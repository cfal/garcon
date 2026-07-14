import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalSurfaceTestHost from './TerminalSurfaceTestHost.svelte';
import { ApiError } from '$lib/api/client';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

describe('TerminalSurface', () => {
	beforeEach(() => {
		localStorage.clear();
	});
	afterEach(async () => {
		cleanup();
		await new Promise((resolve) => window.setTimeout(resolve, 30));
	});

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

	it('shows input helpers and guarded tab Close only in mobile presentation', async () => {
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
		expect(screen.queryByRole('button', { name: 'Close terminal tab' })).toBeNull();

		await rerender({ host: 'mobile', onClose, onModifier, onToolbarKey });
		await fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Close terminal tab' }));

		expect(onModifier).toHaveBeenCalledWith('ctrl');
		expect(onToolbarKey).toHaveBeenCalledWith('escape');
		expect(onClose).toHaveBeenCalledWith('terminal:terminal-1');
	});

	it('terminates the session only from the explicit toolbar action', async () => {
		const onTerminate = vi.fn();
		render(TerminalSurfaceTestHost, { host: 'main', onTerminate });

		await fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));

		expect(onTerminate).toHaveBeenCalledWith('terminal-1');
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

	it('delegates primary focus to the terminal runtime', async () => {
		const onFocus = vi.fn();
		const { rerender } = render(TerminalSurfaceTestHost, {
			host: 'main',
			onFocus,
			focusRequestToken: 0,
		});

		await rerender({ host: 'main', onFocus, focusRequestToken: 1 });

		expect(onFocus).toHaveBeenCalledOnce();
	});

	it('changes and persists the terminal font size from the toolbar settings', async () => {
		const onFontSize = vi.fn();
		render(TerminalSurfaceTestHost, { host: 'main', onFontSize });

		await waitFor(() => expect(onFontSize).toHaveBeenLastCalledWith(13));
		await fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }));
		await fireEvent.pointerDown(screen.getByRole('button', { name: 'Font size' }), {
			button: 0,
			ctrlKey: false,
			pointerType: 'mouse',
		});
		await fireEvent.pointerUp(await screen.findByRole('option', { name: '18px' }), {
			pointerType: 'mouse',
		});

		await waitFor(() => expect(onFontSize).toHaveBeenLastCalledWith(18));
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ terminalFontSize: '18' });
	});
});
