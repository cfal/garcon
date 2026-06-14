import { render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shell-runtime.svelte', () => {
	class ShellRuntime {
		isConnected = true;
		isInitialized = true;
		isRestarting = false;
		isConnecting = false;
		clipboardMessage = '';
		isTerminalFocused = true;
		needsInit = false;

		constructor(_opts: unknown) {}

		applyTheme(): void {}
		cleanup(): void {}
		focusTerminal(): void {}
		sendToolbarKey(): boolean {
			return true;
		}
		pasteFromClipboard(): Promise<boolean> {
			return Promise.resolve(true);
		}
		disconnectFromShell(): void {}
		restartShell(): void {}
	}

	return { ShellRuntime };
});

import Shell from '../Shell.svelte';

describe('Shell mobile toolbar', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn().mockImplementation(() => ({
				matches: true,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
			})),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('renders coarse-pointer toolbar buttons with accessible names and no md breakpoint hiding', async () => {
		const { container } = render(Shell, {
			projectPath: '/tmp/project',
			chatId: 'chat-12345678',
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Down' })).toBeTruthy();
		});

		expect(screen.getByRole('button', { name: 'Left' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Right' })).toBeTruthy();

		const toolbar = container.querySelector('[class*="backdrop-blur"]');
		expect(toolbar).toBeTruthy();
		expect(toolbar?.getAttribute('class') ?? '').not.toContain('md:hidden');
	});
});
