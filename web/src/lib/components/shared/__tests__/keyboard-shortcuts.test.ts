import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import KeyboardShortcutsHarness from './KeyboardShortcutsHarness.svelte';

function createMockAppShell() {
	return {
		openSidebarSearch: vi.fn(),
		requestNewChat: vi.fn(),
		requestRenameSelectedChat: vi.fn(),
		requestDeleteSelectedChat: vi.fn(),
		openSettings: vi.fn(),
	};
}

describe('KeyboardShortcuts', () => {
	it('opens sidebar search on Ctrl-S with the same global scope as the command palette', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHarness, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));

		expect(appShell.openSidebarSearch).toHaveBeenCalledTimes(1);
	});

	it('opens sidebar search on Ctrl-S even when focus is inside an input', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHarness, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		try {
				input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
			expect(appShell.openSidebarSearch).toHaveBeenCalledTimes(1);
		} finally {
			input.remove();
		}
	});

	it('requests delete on Ctrl-D', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHarness, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }));

		expect(appShell.requestDeleteSelectedChat).toHaveBeenCalledTimes(1);
	});

	it('requests delete on Ctrl-D even when focus is inside an input', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHarness, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		try {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
			expect(appShell.requestDeleteSelectedChat).toHaveBeenCalledTimes(1);
		} finally {
			input.remove();
		}
	});
});
