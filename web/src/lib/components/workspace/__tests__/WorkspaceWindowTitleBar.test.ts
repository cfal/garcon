import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceWindowTitleBar from '../WorkspaceWindowTitleBar.svelte';
import { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';
import type {
	DesktopWorkspaceNode,
	SurfaceDescriptor,
	WorkspaceWindowId,
	WorkspaceWindowNode,
} from '$lib/workspace/surface-types.js';
import * as m from '$lib/paraglide/messages.js';

const {
	closeSurface,
	closeWindow,
	createTerminal,
	enterWindowFullscreen,
	exitWindowFullscreen,
	focusSurface,
	moveTabToWindow,
	noteWindowChromeFocus,
	openSingletonAsTab,
	openChatInNewWindow,
	openTabInNewWindow,
	runtime,
} = vi.hoisted(() => ({
	closeSurface: vi.fn(async () => true),
	closeWindow: vi.fn(async () => true),
	createTerminal: vi.fn(async () => 'terminal-created'),
	enterWindowFullscreen: vi.fn(async () => true),
	exitWindowFullscreen: vi.fn(async () => undefined),
	focusSurface: vi.fn(async () => undefined),
	moveTabToWindow: vi.fn(async () => undefined),
	noteWindowChromeFocus: vi.fn(),
	openSingletonAsTab: vi.fn(async () => undefined),
	openChatInNewWindow: vi.fn(async () => 'window-chat-copy'),
	openTabInNewWindow: vi.fn(async () => undefined),
	runtime: {
		fullscreenWindowId: null as WorkspaceWindowId | null,
		desktopRoot: null as DesktopWorkspaceNode | null,
		windowCount: 1,
		closeBlocked: true,
		surfaceCloseBlocked: false,
		surfaces: {} as Record<string, SurfaceDescriptor>,
	},
}));

vi.mock('$lib/context', () => ({
	getWorkspaceCoordinator: () => ({
		layout: {
			get snapshot() {
				return {
					fullscreenWindowId: runtime.fullscreenWindowId,
					desktopRoot: runtime.desktopRoot ?? {
						type: 'window',
						id: 'window-main',
						tabs: {
							order: Object.keys(runtime.surfaces),
							activeId: Object.keys(runtime.surfaces)[0] ?? 'chat-view:window-main',
							mru: Object.keys(runtime.surfaces),
						},
					},
					surfaces: runtime.surfaces,
				};
			},
			surface: (surfaceId: string) => runtime.surfaces[surfaceId] ?? null,
		},
		get windowCount() {
			return runtime.windowCount;
		},
		isWindowCloseBlocked: () => runtime.closeBlocked,
		isSurfaceCloseBlocked: () => runtime.surfaceCloseBlocked,
		noteWindowChromeFocus,
		focusSurface,
		moveTabToWindow,
		openChatInNewWindow,
		openTabInNewWindow,
		openSingletonAsTab,
		createTerminal,
		openTerminalSession: vi.fn(async () => undefined),
		closeSurface,
		enterWindowFullscreen,
		exitWindowFullscreen,
		closeWindow,
	}),
	getChatSessions: () => ({ byId: {} }),
	getNotifications: () => ({ error: vi.fn() }),
	getFileSessions: () => ({ showOpenFiles: vi.fn() }),
	getTerminalRegistry: () => ({ orderedSessions: [] }),
	getGhCapability: () => ({ hasChecked: true, available: true }),
	getOptionalTransientLayers: () => null,
}));

const chatSurface = {
	id: 'chat-view:window-main',
	type: 'chat',
	chatId: 'chat-a',
} as const satisfies SurfaceDescriptor;
const gitSurface = {
	id: 'singleton:git',
	type: 'singleton',
	kind: 'git',
} as const satisfies SurfaceDescriptor;

function workspaceWindow(
	order: readonly string[],
	activeId = order[0] ?? chatSurface.id,
): WorkspaceWindowNode {
	return {
		type: 'window',
		id: 'window-main',
		tabs: { order, activeId, mru: [activeId, ...order.filter((id) => id !== activeId)] },
	};
}

function fourWindowRoot(tabs: WorkspaceWindowNode['tabs']): DesktopWorkspaceNode {
	const otherWindow = (id: WorkspaceWindowId, surfaceId: string): WorkspaceWindowNode => ({
		type: 'window',
		id,
		tabs: { order: [surfaceId], activeId: surfaceId, mru: [surfaceId] },
	});
	return {
		type: 'partition',
		id: 'partition-root',
		direction: 'horizontal',
		ratio: 0.5,
		children: [
			{
				type: 'partition',
				id: 'partition-left',
				direction: 'vertical',
				ratio: 0.5,
				children: [
					{ type: 'window', id: 'window-main', tabs },
					otherWindow('window-two', 'terminal:two'),
				],
			},
			{
				type: 'partition',
				id: 'partition-right',
				direction: 'vertical',
				ratio: 0.5,
				children: [
					otherWindow('window-three', 'terminal:three'),
					otherWindow('window-four', 'terminal:four'),
				],
			},
		],
	};
}

function renderTitleBar(node: WorkspaceWindowNode, isCurrent = true) {
	return render(WorkspaceWindowTitleBar, {
		workspaceWindow: node,
		labelFor: (surfaceId: string) =>
			surfaceId === chatSurface.id ? 'Chat A' : surfaceId === gitSurface.id ? 'Git' : surfaceId,
		dnd: new WorkspaceWindowDndController(createWorkspaceLayoutStore()),
		isCurrent,
	});
}

describe('WorkspaceWindowTitleBar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		runtime.fullscreenWindowId = null;
		runtime.desktopRoot = null;
		runtime.windowCount = 1;
		runtime.closeBlocked = true;
		runtime.surfaceCloseBlocked = false;
		runtime.surfaces = { [chatSurface.id]: chatSurface, [gitSurface.id]: gitSurface };
		vi.stubGlobal('ResizeObserver', undefined);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('shows a title and direct controls for a one-tab window', () => {
		renderTitleBar(workspaceWindow([chatSurface.id]));

		expect(screen.queryByRole('tablist')).toBeNull();
		const toolbar = screen.getByRole('toolbar');
		expect(toolbar.classList.contains('relative')).toBe(true);
		expect(toolbar.classList.contains('z-50')).toBe(true);
		expect(toolbar.classList.contains('bg-accent/50')).toBe(false);
		expect(screen.getByText('Chat A')).toBeTruthy();
		expect(screen.getByRole('button', { name: m.workspace_add_to_window() })).toBeTruthy();
		expect(screen.getByRole('button', { name: m.workspace_window_actions() })).toBeTruthy();
		expect(screen.getByRole('button', { name: m.workspace_fullscreen() })).toBeTruthy();
		const close = screen.getByRole('button', { name: m.workspace_close_window() });
		expect((close as HTMLButtonElement).disabled).toBe(true);
		expect(close.title).toBe(m.workspace_close_window_disabled());
	});

	it('uses a window-local tablist when multiple tabs exist', () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id));

		const tablist = screen.getByRole('tablist');
		expect(tablist).toBeTruthy();
		expect(screen.getByRole('tab', { name: 'Git' }).getAttribute('aria-selected')).toBe('true');
		expect(screen.getByRole('tab', { name: 'Chat A' }).getAttribute('aria-selected')).toBe('false');
		expect(tablist.closest('header')?.classList.contains('h-10')).toBe(true);
	});

	it('uses a stronger title-bar background only for the current window in a multi-window layout', () => {
		runtime.windowCount = 2;
		const current = renderTitleBar(workspaceWindow([chatSurface.id])).container.querySelector(
			'[data-workspace-window-titlebar]',
		)!;
		expect(current.classList.contains('bg-accent/50')).toBe(true);
		cleanup();

		const inactive = renderTitleBar(
			workspaceWindow([chatSurface.id]),
			false,
		).container.querySelector('[data-workspace-window-titlebar]')!;
		expect(inactive.classList.contains('bg-muted/30')).toBe(true);
		expect(inactive.classList.contains('bg-accent/50')).toBe(false);
	});

	it('keeps the fullscreen title bar muted', () => {
		runtime.windowCount = 2;
		runtime.fullscreenWindowId = 'window-main';
		const toolbar = renderTitleBar(workspaceWindow([chatSurface.id])).container.querySelector(
			'[data-workspace-window-titlebar]',
		)!;

		expect(toolbar.classList.contains('bg-muted/30')).toBe(true);
		expect(toolbar.classList.contains('bg-accent/50')).toBe(false);
	});

	it('describes the final Chat view close block', () => {
		runtime.windowCount = 2;
		const close = renderTitleBar(workspaceWindow([chatSurface.id])).getByRole('button', {
			name: m.workspace_close_window(),
		});

		expect(close.title).toBe(m.workspace_close_window_final_chat_disabled());
	});

	it('targets reversible fullscreen and close at the exact window', async () => {
		runtime.windowCount = 2;
		runtime.closeBlocked = false;
		renderTitleBar(workspaceWindow([chatSurface.id]));

		await fireEvent.click(screen.getByRole('button', { name: m.workspace_fullscreen() }));
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_close_window() }));

		expect(enterWindowFullscreen).toHaveBeenCalledWith('window-main');
		expect(closeWindow).toHaveBeenCalledWith('window-main');
	});

	it('dispatches the exact window when exiting fullscreen', async () => {
		runtime.fullscreenWindowId = 'window-main';
		renderTitleBar(workspaceWindow([chatSurface.id]));

		await fireEvent.click(screen.getByRole('button', { name: m.workspace_exit_fullscreen() }));

		expect(exitWindowFullscreen).toHaveBeenCalledWith('window-main');
		expect(enterWindowFullscreen).not.toHaveBeenCalled();
	});

	it('opens plus-menu views as tabs in that window', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id]));
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_add_to_window() }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_open_git_history() }));

		expect(openSingletonAsTab).toHaveBeenCalledWith('git-history', 'window-main');
	});

	it('closes the plus menu when New Terminal enters its busy state', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id]));
		const trigger = screen.getByRole('button', { name: m.workspace_add_to_window() });
		await fireEvent.click(trigger);
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_new_terminal() }));

		expect(createTerminal).toHaveBeenCalledWith('window-main', 'workspace-window:window-main');
		await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
	});

	it('keeps creation actions out of the current-tab menu', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id]));
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));

		expect(screen.queryByRole('menuitem', { name: m.workspace_new_terminal() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.workspace_open_git_history() })).toBeNull();
	});

	it('closes the active movable tab from the window menu', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id));
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_close_tab() }));

		expect(closeSurface).toHaveBeenCalledWith(gitSurface.id);
	});

	it('places active-tab movement actions before current-tab actions', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id));
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));

		const menu = document.querySelector('[data-workspace-window-menu="window-main"]')!;
		const actions = Array.from(
			menu.querySelectorAll<HTMLElement>('[data-workspace-window-tab-action]'),
		);
		expect(actions.map((item) => item.dataset.workspaceWindowTabAction)).toEqual([
			'move-left',
			'move-right',
			'open-left',
			'open-right',
			'open-top',
			'open-bottom',
		]);
		expect(menu.querySelector('[data-workspace-window-tab-actions-separator]')).toBeTruthy();

		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_move_tab_left() }));
		expect(moveTabToWindow).toHaveBeenCalledWith(gitSurface.id, 'window-main', 0);
	});

	it('offers Chat directional actions from the current-tab menu', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id]));
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));
		await fireEvent.click(
			screen.getByRole('menuitem', { name: m.workspace_open_tab_new_window_right() }),
		);

		expect(openChatInNewWindow).toHaveBeenCalledWith('chat-a', 'window-main', 'right');
	});

	it('offers keyboard-accessible ordering for movable local tabs', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id));
		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Git' }));
		await fireEvent.click(
			await screen.findByRole('menuitem', { name: m.workspace_move_tab_left() }),
		);

		await waitFor(() =>
			expect(moveTabToWindow).toHaveBeenCalledWith('singleton:git', 'window-main', 0),
		);
	});

	it('offers Chat tabs the directional new-window context actions', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id]));
		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat A' }));
		await fireEvent.click(
			await screen.findByRole('menuitem', { name: m.workspace_open_tab_new_window_right() }),
		);

		await waitFor(() =>
			expect(openChatInNewWindow).toHaveBeenCalledWith('chat-a', 'window-main', 'right'),
		);
	});

	it('disables directional new-window actions in both tab menus at the window cap', async () => {
		const node = workspaceWindow([chatSurface.id, gitSurface.id]);
		const directionalActionLabels = [
			m.workspace_open_tab_new_window_left(),
			m.workspace_open_tab_new_window_right(),
			m.workspace_open_tab_new_window_above(),
			m.workspace_open_tab_new_window_below(),
		];
		runtime.windowCount = 4;
		runtime.desktopRoot = fourWindowRoot(node.tabs);
		renderTitleBar(node);

		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));
		for (const label of directionalActionLabels) {
			expect(
				screen.getByRole('menuitem', { name: label }).getAttribute('data-disabled'),
			).not.toBeNull();
		}
		await fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() =>
			expect(
				screen.queryByRole('menuitem', { name: m.workspace_open_tab_new_window_right() }),
			).toBeNull(),
		);

		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat A' }));
		for (const label of directionalActionLabels) {
			expect(
				(await screen.findByRole('menuitem', { name: label })).getAttribute('data-disabled'),
			).not.toBeNull();
		}
	});

	it('shows the final Chat close action as disabled', async () => {
		runtime.surfaceCloseBlocked = true;
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id]));
		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat A' }));

		const close = await screen.findByRole('menuitem', { name: m.workspace_close_tab() });
		expect(close.getAttribute('data-disabled')).not.toBeNull();
	});
});
