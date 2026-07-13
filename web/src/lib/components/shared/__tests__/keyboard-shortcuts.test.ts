import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import KeyboardShortcutsHost from './KeyboardShortcutsHost.svelte';

function createMockAppShell() {
	return {
		openSidebarSearch: vi.fn(),
		requestNewChat: vi.fn(),
		requestRenameSelectedChat: vi.fn(),
		requestDeleteSelectedChat: vi.fn(),
		openSettings: vi.fn(),
	};
}

function createMockNavigation() {
	return {
		requestNavigateChatAbove: vi.fn(),
		requestNavigateChatBelow: vi.fn(),
	};
}

describe('KeyboardShortcuts', () => {
	it('opens sidebar search on Ctrl-S while the chat list owns focus', async () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));

		expect(appShell.openSidebarSearch).toHaveBeenCalledTimes(1);
	});

	it('opens sidebar search on Ctrl-S while Chat owns focus', async () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
			focusOwner: 'chat',
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
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }));

		expect(appShell.requestDeleteSelectedChat).toHaveBeenCalledTimes(1);
	});

	it('does not request delete while Chat owns focus', async () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
			focusOwner: 'chat',
		});

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		try {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
			expect(appShell.requestDeleteSelectedChat).not.toHaveBeenCalled();
		} finally {
			input.remove();
		}
	});

	it('navigates to chat above on Ctrl-Shift-J', async () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, shiftKey: true }));

		expect(navigation.requestNavigateChatAbove).toHaveBeenCalledTimes(1);
		expect(navigation.requestNavigateChatBelow).not.toHaveBeenCalled();
	});

	it('navigates to chat below on Ctrl-Shift-L', async () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true }));

		expect(navigation.requestNavigateChatBelow).toHaveBeenCalledTimes(1);
		expect(navigation.requestNavigateChatAbove).not.toHaveBeenCalled();
	});

	it('does not navigate the chat list while Chat owns focus', async () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
			focusOwner: 'chat',
		});

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		try {
			input.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, shiftKey: true, bubbles: true }),
			);
			expect(navigation.requestNavigateChatAbove).not.toHaveBeenCalled();

			input.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true, bubbles: true }),
			);
			expect(navigation.requestNavigateChatBelow).not.toHaveBeenCalled();
		} finally {
			input.remove();
		}
	});

	it('does not route Ctrl-S to Chat while a confirmation owns focus', async () => {
		const appShell = createMockAppShell();
		render(KeyboardShortcutsHost, {
			appShell,
			navigation: createMockNavigation(),
			focusOwner: 'chat',
			transientKind: 'confirmation',
		});
		const input = screen.getByRole('textbox', { name: 'Transient input' });
		input.focus();
		const event = new KeyboardEvent('keydown', {
			key: 's',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});

		input.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(appShell.openSidebarSearch).not.toHaveBeenCalled();
	});

	it('does not route Cmd-S to a file surface while an application dialog owns focus', async () => {
		const onFileSave = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'file',
			transientKind: 'application-dialog',
			onFileSave,
		});
		const input = screen.getByRole('textbox', { name: 'Transient input' });
		input.focus();
		const event = new KeyboardEvent('keydown', {
			key: 's',
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});

		input.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(onFileSave).not.toHaveBeenCalled();
	});

	it('routes Cmd-S to a file surface hosted by the active file dialog', async () => {
		const onFileSave = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'file',
			transientKind: 'file-dialog',
			transientSurface: true,
			onFileSave,
		});
		const input = screen.getByRole('textbox', { name: 'Transient input' });
		input.focus();

		input.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 's',
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(onFileSave).toHaveBeenCalledOnce();
	});

	it.each(['menu', 'popover'] as const)(
		'keeps nonmodal %s shortcuts routed to their workspace owner',
		(transientKind) => {
			const appShell = createMockAppShell();
			render(KeyboardShortcutsHost, {
				appShell,
				navigation: createMockNavigation(),
				focusOwner: 'chat',
				transientKind,
			});
			const input = screen.getByRole('textbox', { name: 'Transient input' });
			input.focus();

			input.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 's',
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
				}),
			);

			expect(appShell.openSidebarSearch).toHaveBeenCalledOnce();
		},
	);
});
