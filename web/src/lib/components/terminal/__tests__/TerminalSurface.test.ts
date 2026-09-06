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
		render(TerminalSurfaceTestHost, { host: 'mobile' });

		expect(screen.getByText('Started in /workspace/project')).toBeTruthy();
	});

	it('labels placed sessions with their workspace window number', () => {
		render(TerminalSurfaceTestHost, { host: 'mobile' });

		expect(screen.getByRole('option', { name: 'Terminal 1 - running - Window 1' })).toBeTruthy();
		expect(screen.getByRole('option', { name: 'Build logs - running' })).toBeTruthy();
	});

	it('shows input helpers on a coarse-pointer desktop', async () => {
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
			render(TerminalSurfaceTestHost, { host: 'window-main' });
			expect(await screen.findByRole('button', { name: 'Ctrl' })).toBeTruthy();
		} finally {
			Object.defineProperty(window, 'matchMedia', {
				configurable: true,
				value: originalMatchMedia,
			});
		}
	});

	it('omits the session toolbar from desktop window presentation', () => {
		render(TerminalSurfaceTestHost, { host: 'window-main' });

		expect(screen.queryByRole('combobox', { name: 'Terminal session' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Terminate' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Terminal settings' })).toBeNull();
	});

	it('shows input helpers and guarded tab Close only in mobile presentation', async () => {
		const onClose = vi.fn();
		const onModifier = vi.fn();
		const onToolbarKey = vi.fn();
		const { rerender } = render(TerminalSurfaceTestHost, {
			host: 'window-main',
			onClose,
			onModifier,
			onToolbarKey,
		});

		expect(screen.queryByRole('button', { name: 'Ctrl' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Close terminal tab' })).toBeNull();

		await rerender({ host: 'mobile', onClose, onModifier, onToolbarKey });
		await fireEvent.click(await screen.findByRole('button', { name: 'Ctrl' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Close terminal tab' }));

		expect(onModifier).toHaveBeenCalledWith('ctrl');
		expect(onToolbarKey).toHaveBeenCalledWith('escape');
		expect(onClose).toHaveBeenCalledWith('terminal:terminal-1');
	});

	it('shows an exited-terminal cleanup failure from mobile Close', async () => {
		render(TerminalSurfaceTestHost, {
			host: 'mobile',
			closeError: new Error('Terminal cleanup failed'),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Close terminal tab' }));

		expect(await screen.findByText('Terminal cleanup failed')).toBeTruthy();
	});

	it('adds the mobile renderer inset only in mobile presentation', async () => {
		const { container, rerender } = render(TerminalSurfaceTestHost, { host: 'window-main' });
		const terminalHost = container.querySelector<HTMLElement>('[data-terminal-host]');

		expect(terminalHost?.classList.contains('mobile-terminal-host')).toBe(false);
		expect(terminalHost?.classList.contains('bg-background')).toBe(true);
		expect(terminalHost?.classList.contains('bg-terminal-bg')).toBe(false);

		await rerender({ host: 'mobile' });

		expect(terminalHost?.classList.contains('mobile-terminal-host')).toBe(true);
		expect(terminalHost?.classList.contains('bg-background')).toBe(false);
		expect(terminalHost?.classList.contains('bg-terminal-bg')).toBe(true);
	});

	it('terminates the session only from the explicit mobile toolbar action', async () => {
		const onTerminate = vi.fn();
		render(TerminalSurfaceTestHost, { host: 'mobile', onTerminate });

		await fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));

		expect(onTerminate).toHaveBeenCalledWith('terminal-1');
	});

	it('renames the session from the mobile toolbar action', async () => {
		const onRename = vi.fn();
		render(TerminalSurfaceTestHost, { host: 'mobile', onRename });

		await fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		const input = screen.getByRole('textbox', { name: 'Terminal name' });
		await fireEvent.input(input, { target: { value: 'Dev server' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(onRename).toHaveBeenCalledWith('terminal-1', 'Dev server');
	});

	it('focuses the session picker when the server reports the terminal cap', async () => {
		render(TerminalSurfaceTestHost, {
			host: 'mobile',
			createError: new ApiError(409, 'Limit reached', 'terminal-limit'),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
		await Promise.resolve();
		expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Terminal session' }));
	});

	it('switches the current terminal tab instead of opening another tab', async () => {
		const onSwitch = vi.fn();
		render(TerminalSurfaceTestHost, { host: 'mobile', onSwitch });

		await fireEvent.change(screen.getByRole('combobox', { name: 'Terminal session' }), {
			target: { value: 'terminal-2' },
		});

		expect(onSwitch).toHaveBeenCalledWith('terminal-1', 'terminal-2');
	});

	it('creates a terminal by replacing the current terminal tab', async () => {
		const onCreateReplacing = vi.fn();
		render(TerminalSurfaceTestHost, { host: 'mobile', onCreateReplacing });

		await fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));

		expect(onCreateReplacing).toHaveBeenCalledWith('terminal-1');
	});

	it('delegates primary focus to the terminal runtime', async () => {
		const onFocus = vi.fn();
		const onFontSize = vi.fn();
		const { rerender } = render(TerminalSurfaceTestHost, {
			host: 'window-main',
			onFocus,
			onFontSize,
			focusRequestToken: 0,
		});
		await waitFor(() => expect(onFontSize).toHaveBeenCalled());

		await rerender({ host: 'window-main', onFocus, onFontSize, focusRequestToken: 1 });

		await waitFor(() => expect(onFocus).toHaveBeenCalledOnce());
	});

	it('ignores runtime completion after the surface unmounts', async () => {
		let releaseRuntime!: () => void;
		const runtimeDelay = new Promise<void>((resolve) => {
			releaseRuntime = resolve;
		});
		const onFontSize = vi.fn();
		const view = render(TerminalSurfaceTestHost, {
			host: 'window-main',
			runtimeDelay,
			onFontSize,
		});

		view.unmount();
		releaseRuntime();
		await Promise.resolve();
		await Promise.resolve();

		expect(onFontSize).not.toHaveBeenCalled();
	});

	it('ignores runtime completion after switching terminal sessions', async () => {
		let releaseFirstRuntime!: () => void;
		const firstRuntimeDelay = new Promise<void>((resolve) => {
			releaseFirstRuntime = resolve;
		});
		const onFontSize = vi.fn();
		const runtimeDelays = {
			'terminal-1': firstRuntimeDelay,
			'terminal-2': Promise.resolve(),
		};
		const { rerender } = render(TerminalSurfaceTestHost, {
			host: 'window-main',
			terminalId: 'terminal-1',
			runtimeDelays,
			onFontSize,
		});

		await rerender({
			host: 'window-main',
			terminalId: 'terminal-2',
			runtimeDelays,
			onFontSize,
		});
		await waitFor(() => expect(onFontSize).toHaveBeenCalledOnce());
		releaseFirstRuntime();
		await Promise.resolve();
		await Promise.resolve();

		expect(onFontSize).toHaveBeenCalledOnce();
	});

	it('shows a retry action for runtime loading failures', async () => {
		const onReattach = vi.fn();
		render(TerminalSurfaceTestHost, {
			host: 'window-main',
			runtimeError: 'Terminal chunk unavailable',
			onReattach,
		});

		expect(screen.getByText('Terminal chunk unavailable')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

		expect(onReattach).toHaveBeenCalledWith('terminal-1');
	});

	it('changes and persists the terminal font size from the toolbar settings', async () => {
		const onFontSize = vi.fn();
		render(TerminalSurfaceTestHost, { host: 'mobile', onFontSize });

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
