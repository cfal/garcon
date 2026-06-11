import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import KeyboardShortcutsHost from './KeyboardShortcutsHost.svelte';

function createMockAppShell() {
	return {
		openSidebarSearch: vi.fn(),
		requestNewChat: vi.fn(),
		requestRenameSelectedChat: vi.fn(),
		requestDeleteSelectedChat: vi.fn(),
		openSettings: vi.fn(),
		requestNavigateChatAbove: vi.fn(),
		requestNavigateChatBelow: vi.fn(),
	};
}

describe('KeyboardShortcuts', () => {
	it('opens sidebar search on Ctrl-S with the same global scope as the command palette', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHost, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));

		expect(appShell.openSidebarSearch).toHaveBeenCalledTimes(1);
	});

	it('opens sidebar search on Ctrl-S even when focus is inside an input', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHost, {
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

		render(KeyboardShortcutsHost, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }));

		expect(appShell.requestDeleteSelectedChat).toHaveBeenCalledTimes(1);
	});

	it('requests delete on Ctrl-D even when focus is inside an input', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHost, {
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

	it('navigates to chat above on Ctrl-Shift-J', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHost, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, shiftKey: true }));

		expect(appShell.requestNavigateChatAbove).toHaveBeenCalledTimes(1);
		expect(appShell.requestNavigateChatBelow).not.toHaveBeenCalled();
	});

	it('navigates to chat below on Ctrl-Shift-L', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHost, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true }));

		expect(appShell.requestNavigateChatBelow).toHaveBeenCalledTimes(1);
		expect(appShell.requestNavigateChatAbove).not.toHaveBeenCalled();
	});

	it('navigates chat above/below even when focus is inside an input', async () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHost, {
			appShell,
			onToggleCommandMenu: vi.fn(),
		});

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		try {
			input.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, shiftKey: true, bubbles: true }),
			);
			expect(appShell.requestNavigateChatAbove).toHaveBeenCalledTimes(1);

			input.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true, bubbles: true }),
			);
			expect(appShell.requestNavigateChatBelow).toHaveBeenCalledTimes(1);
		} finally {
			input.remove();
		}
	});
});
