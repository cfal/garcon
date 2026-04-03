import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import KeyboardShortcutsHarness from './KeyboardShortcutsHarness.svelte';

describe('KeyboardShortcuts', () => {
	it('opens sidebar search on Ctrl-O with the same global scope as the command palette', async () => {
		const appShell = {
			openSidebarSearch: vi.fn(),
			requestNewChat: vi.fn(),
			requestRenameSelectedChat: vi.fn(),
			openSettings: vi.fn(),
		};

		render(KeyboardShortcutsHarness, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true }));

		expect(appShell.openSidebarSearch).toHaveBeenCalledTimes(1);
	});

	it('opens sidebar search on Ctrl-O even when focus is inside an input', async () => {
		const appShell = {
			openSidebarSearch: vi.fn(),
			requestNewChat: vi.fn(),
			requestRenameSelectedChat: vi.fn(),
			openSettings: vi.fn(),
		};

		render(KeyboardShortcutsHarness, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		try {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true }));
			expect(appShell.openSidebarSearch).toHaveBeenCalledTimes(1);
		} finally {
			input.remove();
		}
	});
});
