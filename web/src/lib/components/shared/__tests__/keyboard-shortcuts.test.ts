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

	it('moves left between tabs on Ctrl-Shift-J while a workspace pane owns focus', () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();
		const onFocusPreviousTab = vi.fn(() => true);

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
			focusOwner: 'chat',
			onFocusPreviousTab,
		});

		const event = new KeyboardEvent('keydown', {
			key: 'j',
			ctrlKey: true,
			shiftKey: true,
			cancelable: true,
		});
		window.dispatchEvent(event);

		expect(onFocusPreviousTab).toHaveBeenCalledOnce();
		expect(event.defaultPrevented).toBe(true);
		expect(navigation.requestNavigateChatAbove).not.toHaveBeenCalled();
	});

	it('moves right between tabs on Ctrl-Shift-L while a workspace pane owns focus', () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();
		const onFocusNextTab = vi.fn(() => true);

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
			focusOwner: 'chat',
			onFocusNextTab,
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true }));

		expect(onFocusNextTab).toHaveBeenCalledOnce();
		expect(navigation.requestNavigateChatBelow).not.toHaveBeenCalled();
	});

	it('toggles focus between the main view and right sidebar on Ctrl-Shift-O', () => {
		const onToggleMainSidebarFocus = vi.fn();
		const event = new KeyboardEvent('keydown', {
			key: 'o',
			ctrlKey: true,
			shiftKey: true,
			cancelable: true,
		});

		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			onToggleMainSidebarFocus,
		});

		window.dispatchEvent(event);

		expect(onToggleMainSidebarFocus).toHaveBeenCalledOnce();
		expect(event.defaultPrevented).toBe(true);
	});

	it('navigates chat items on Ctrl-Shift-P and Ctrl-Shift-N while the chat list owns focus', () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();
		const onToggleCommandMenu = vi.fn();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu,
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, shiftKey: true }));

		expect(navigation.requestNavigateChatAbove).toHaveBeenCalledOnce();
		expect(navigation.requestNavigateChatBelow).toHaveBeenCalledOnce();
		expect(onToggleCommandMenu).not.toHaveBeenCalled();
		expect(appShell.requestNewChat).not.toHaveBeenCalled();
	});

	it('keeps unshifted Ctrl-P assigned to Command Palette', () => {
		const onToggleCommandMenu = vi.fn();

		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			onToggleCommandMenu,
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));

		expect(onToggleCommandMenu).toHaveBeenCalledOnce();
	});

	it('does not navigate chat items while a workspace surface owns focus', () => {
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation,
			onToggleCommandMenu: vi.fn(),
			focusOwner: 'chat',
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, shiftKey: true }));

		expect(navigation.requestNavigateChatAbove).not.toHaveBeenCalled();
		expect(navigation.requestNavigateChatBelow).not.toHaveBeenCalled();
	});

	it('keeps Ctrl-N assigned to New Chat', () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }));

		expect(appShell.requestNewChat).toHaveBeenCalledOnce();
		expect(navigation.requestNavigateChatBelow).not.toHaveBeenCalled();
	});

	it('leaves Ctrl-P and Ctrl-N to an explicitly targeted terminal surface', () => {
		const appShell = createMockAppShell();
		const onToggleCommandMenu = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell,
			navigation: createMockNavigation(),
			onToggleCommandMenu,
			focusOwner: 'terminal',
		});
		const terminalInput = screen.getByRole('textbox', { name: 'Terminal input' });
		const previousHistory = new KeyboardEvent('keydown', {
			key: 'p',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		const nextHistory = new KeyboardEvent('keydown', {
			key: 'n',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});

		terminalInput.dispatchEvent(previousHistory);
		terminalInput.dispatchEvent(nextHistory);

		expect(previousHistory.defaultPrevented).toBe(false);
		expect(nextHistory.defaultPrevented).toBe(false);
		expect(onToggleCommandMenu).not.toHaveBeenCalled();
		expect(appShell.requestNewChat).not.toHaveBeenCalled();
	});

	it('keeps Meta-P global while a terminal owns input', () => {
		const onToggleCommandMenu = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			onToggleCommandMenu,
			focusOwner: 'terminal',
		});
		const terminalInput = screen.getByRole('textbox', { name: 'Terminal input' });

		terminalInput.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'p',
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(onToggleCommandMenu).toHaveBeenCalledOnce();
	});

	it('does not use the old tab chords for chat-list navigation', () => {
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, shiftKey: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true }));

		expect(navigation.requestNavigateChatAbove).not.toHaveBeenCalled();
		expect(navigation.requestNavigateChatBelow).not.toHaveBeenCalled();
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

		expect(event.defaultPrevented).toBe(false);
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

		expect(event.defaultPrevented).toBe(false);
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
