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

	it('requests delete on Ctrl-Shift-D', async () => {
		const appShell = createMockAppShell();
		const navigation = createMockNavigation();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation,
			onToggleCommandMenu: vi.fn(),
		});

		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'D', ctrlKey: true, shiftKey: true }),
		);

		expect(appShell.requestDeleteSelectedChat).toHaveBeenCalledTimes(1);
	});

	it('consumes Ctrl-D without deleting while the chat list owns focus', () => {
		const appShell = createMockAppShell();
		const event = new KeyboardEvent('keydown', {
			key: 'd',
			ctrlKey: true,
			cancelable: true,
		});

		render(KeyboardShortcutsHost, {
			appShell,
			navigation: createMockNavigation(),
		});
		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(appShell.requestDeleteSelectedChat).not.toHaveBeenCalled();
	});

	it('scrolls the primary region by half a page from surface chrome', () => {
		const onPrimaryScroll = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'file',
			onPrimaryScroll,
		});
		const toolbar = screen.getByRole('button', { name: 'Surface toolbar' });
		toolbar.focus();

		const down = new KeyboardEvent('keydown', {
			key: 'd',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		toolbar.dispatchEvent(down);
		const up = new KeyboardEvent('keydown', {
			key: 'u',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		toolbar.dispatchEvent(up);

		expect(onPrimaryScroll).toHaveBeenNthCalledWith(1, 'later');
		expect(onPrimaryScroll).toHaveBeenNthCalledWith(2, 'earlier');
		expect(down.defaultPrevented).toBe(true);
		expect(up.defaultPrevented).toBe(true);
	});

	it('uses customized half-page bindings in every non-terminal surface', () => {
		const onPrimaryScroll = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'file',
			onPrimaryScroll,
			globalShortcuts: {
				'scroll-half-page-down': { key: 'j', alt: true },
			},
		});
		const region = screen.getByRole('button', { name: 'Primary scroll region' });

		region.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'd',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		region.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'j',
				altKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(onPrimaryScroll).toHaveBeenCalledOnce();
		expect(onPrimaryScroll).toHaveBeenCalledWith('later');
	});

	it('keeps scrolling the last interacted contextual region within a surface', () => {
		const onPrimaryScroll = vi.fn();
		const onContextualScroll = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'chat',
			onPrimaryScroll,
			onContextualScroll,
		});
		const contextual = screen.getByRole('button', { name: 'Contextual scroll region' });
		contextual.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		window.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'd',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(onContextualScroll).toHaveBeenCalledWith('later');
		expect(onPrimaryScroll).not.toHaveBeenCalled();
	});

	it('keeps a contextual pointer choice through its enclosing frame focus fallback', async () => {
		const onPrimaryScroll = vi.fn();
		const onContextualScroll = vi.fn();
		const { container } = render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'file',
			onPrimaryScroll,
			onContextualScroll,
		});
		const frame = container.querySelector<HTMLElement>('[data-workspace-surface-id]');
		expect(frame).toBeTruthy();

		screen
			.getByTestId('contextual-content')
			.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await Promise.resolve();
		frame?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		frame?.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'd',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(onContextualScroll).toHaveBeenCalledWith('later');
		expect(onPrimaryScroll).not.toHaveBeenCalled();
	});

	it('returns to the primary region after interaction leaves a contextual viewport', () => {
		const onPrimaryScroll = vi.fn();
		const onContextualScroll = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'chat',
			onPrimaryScroll,
			onContextualScroll,
		});
		const contextual = screen.getByRole('button', { name: 'Contextual scroll region' });
		const toolbar = screen.getByRole('button', { name: 'Surface toolbar' });
		contextual.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		window.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'd',
				ctrlKey: true,
				cancelable: true,
			}),
		);

		expect(onPrimaryScroll).toHaveBeenCalledWith('later');
		expect(onContextualScroll).not.toHaveBeenCalled();
	});

	it('stops non-terminal view handlers after consuming a half-page shortcut', () => {
		const onPrimaryScroll = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'file',
			onPrimaryScroll,
		});
		const region = screen.getByRole('button', { name: 'Primary scroll region' });
		const localHandler = vi.fn();
		region.addEventListener('keydown', localHandler);

		region.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'd',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(onPrimaryScroll).toHaveBeenCalledWith('later');
		expect(localHandler).not.toHaveBeenCalled();
	});

	it('uses half-page scrolling from editable targets outside the terminal', () => {
		const onPrimaryScroll = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'file',
			onPrimaryScroll,
		});
		const editor = screen.getByRole('textbox', { name: 'File editor input' });
		const localHandler = vi.fn();
		editor.addEventListener('keydown', localHandler);
		const event = new KeyboardEvent('keydown', {
			key: 'd',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});

		editor.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(onPrimaryScroll).toHaveBeenCalledWith('later');
		expect(localHandler).not.toHaveBeenCalled();
	});

	it('scrolls only the top file dialog region while the workspace is inert', () => {
		const onPrimaryScroll = vi.fn();
		const onTransientScroll = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'file',
			transientKind: 'file-dialog',
			transientSurface: true,
			onPrimaryScroll,
			onTransientScroll,
		});
		const dialogShortcut = new KeyboardEvent('keydown', {
			key: 'd',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});

		screen.getByRole('button', { name: 'Transient toolbar' }).dispatchEvent(dialogShortcut);

		expect(dialogShortcut.defaultPrevented).toBe(true);
		expect(onTransientScroll).toHaveBeenCalledWith('later');
		expect(onPrimaryScroll).not.toHaveBeenCalled();

		const backgroundShortcut = new KeyboardEvent('keydown', {
			key: 'u',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		screen.getByRole('button', { name: 'Surface toolbar' }).dispatchEvent(backgroundShortcut);

		expect(backgroundShortcut.defaultPrevented).toBe(false);
		expect(onTransientScroll).toHaveBeenCalledOnce();
		expect(onPrimaryScroll).not.toHaveBeenCalled();
	});

	it('uses a customized delete shortcut immediately', () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation: createMockNavigation(),
			globalShortcuts: { 'delete-chat': { key: 'x', ctrl: true } },
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true }));

		expect(appShell.requestDeleteSelectedChat).toHaveBeenCalledOnce();
	});

	it('does not route a disabled shortcut', () => {
		const appShell = createMockAppShell();

		render(KeyboardShortcutsHost, {
			appShell,
			navigation: createMockNavigation(),
			globalShortcuts: { 'delete-chat': null },
		});

		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'D', ctrlKey: true, shiftKey: true }),
		);

		expect(appShell.requestDeleteSelectedChat).not.toHaveBeenCalled();
	});

	it('leaves Ctrl-D to feed scrolling while Chat owns focus', async () => {
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
				new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }),
			);
			expect(appShell.requestDeleteSelectedChat).not.toHaveBeenCalled();
		} finally {
			input.remove();
		}
	});

	it('requests delete on Ctrl-Shift-D while Chat owns focus', async () => {
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
				new KeyboardEvent('keydown', {
					key: 'D',
					ctrlKey: true,
					shiftKey: true,
					bubbles: true,
				}),
			);
			expect(appShell.requestDeleteSelectedChat).toHaveBeenCalledOnce();
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

	it('toggles focus between the main view and workspace sidebar on Ctrl-Shift-O', () => {
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

	it('defers locally owned editor chords before global commands run', () => {
		const appShell = createMockAppShell();
		const onToggleCommandMenu = vi.fn();
		const onLocalKeydown = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell,
			navigation: createMockNavigation(),
			onToggleCommandMenu,
			focusOwner: 'chat',
			localShortcutOwner: (event) =>
				event.ctrlKey && ['a', 'e', 'p', 'n'].includes(event.key.toLowerCase()),
			onLocalKeydown,
		});
		const target = screen.getByRole('button', { name: 'Local shortcut target' });
		const previousLine = new KeyboardEvent('keydown', {
			key: 'p',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		const nextLine = new KeyboardEvent('keydown', {
			key: 'n',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});

		target.dispatchEvent(previousLine);
		target.dispatchEvent(nextLine);

		expect(previousLine.defaultPrevented).toBe(false);
		expect(nextLine.defaultPrevented).toBe(false);
		expect(onLocalKeydown).toHaveBeenCalledTimes(2);
		expect(onToggleCommandMenu).not.toHaveBeenCalled();
		expect(appShell.requestNewChat).not.toHaveBeenCalled();
	});

	it('lets the top transient consume Escape before a local editor owner', () => {
		const onTransientEscape = vi.fn();
		const onLocalKeydown = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'chat',
			transientKind: 'application-dialog',
			transientSurface: true,
			localShortcutOwner: () => true,
			onLocalKeydown,
			onTransientEscape,
		});

		screen.getByRole('textbox', { name: 'Transient input' }).dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'Escape',
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(onTransientEscape).toHaveBeenCalledOnce();
		expect(onLocalKeydown).not.toHaveBeenCalled();
	});

	it('keeps composing Escape inside a modal editor', () => {
		const onTransientEscape = vi.fn();
		const onLocalKeydown = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'chat',
			transientKind: 'application-dialog',
			transientSurface: true,
			localShortcutOwner: (event) => event.isComposing,
			onLocalKeydown,
			onTransientEscape,
		});
		const escape = new KeyboardEvent('keydown', {
			key: 'Escape',
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(escape, 'isComposing', { value: true });

		screen.getByRole('textbox', { name: 'Transient input' }).dispatchEvent(escape);

		expect(onTransientEscape).not.toHaveBeenCalled();
		expect(onLocalKeydown).toHaveBeenCalledOnce();
		expect(escape.defaultPrevented).toBe(false);
		expect(screen.getByRole('dialog')).toBeTruthy();
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

	it('leaves Ctrl-U and Ctrl-D untouched inside a terminal surface', () => {
		const onPrimaryScroll = vi.fn();
		render(KeyboardShortcutsHost, {
			appShell: createMockAppShell(),
			navigation: createMockNavigation(),
			focusOwner: 'terminal',
			onPrimaryScroll,
		});
		const terminalInput = screen.getByRole('textbox', { name: 'Terminal input' });
		const up = new KeyboardEvent('keydown', {
			key: 'u',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		const down = new KeyboardEvent('keydown', {
			key: 'd',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});

		terminalInput.dispatchEvent(up);
		terminalInput.dispatchEvent(down);

		expect(up.defaultPrevented).toBe(false);
		expect(down.defaultPrevented).toBe(false);
		expect(onPrimaryScroll).not.toHaveBeenCalled();
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
