import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceWindowTitleBar from '../WorkspaceWindowTitleBar.svelte';
import { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';
import { portableSingletonDescriptor } from '$lib/workspace/surface-types.js';
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
	moveTabToNewWindow,
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
	moveTabToNewWindow: vi.fn(async () => undefined),
	runtime: {
		fullscreenWindowId: null as WorkspaceWindowId | null,
		desktopRoot: null as DesktopWorkspaceNode | null,
		windowCount: 1,
		closeBlocked: true,
		surfaceCloseBlocked: false,
		processingChatIds: new Set<string>(),
		terminalSessions: [] as Array<{
			metadata: { terminalId: string; displaySequence: number };
		}>,
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
		moveTabToNewWindow,
		openSingletonAsTab,
		createTerminal,
		openTerminalSession: vi.fn(async () => undefined),
		closeSurface,
		enterWindowFullscreen,
		exitWindowFullscreen,
		closeWindow,
	}),
	getChatSessions: () => ({
		byId: {},
		isChatProcessing: (chatId: string) => runtime.processingChatIds.has(chatId),
	}),
	getNotifications: () => ({ error: vi.fn() }),
	getFileSessions: () => ({ showOpenFiles: vi.fn() }),
	getTerminalRegistry: () => ({
		get orderedSessions() {
			return runtime.terminalSessions;
		},
	}),
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
const otherChatSurface = {
	id: 'chat-view:window-two',
	type: 'chat',
	chatId: 'chat-b',
} as const satisfies SurfaceDescriptor;
const emptyChatSurface = {
	id: 'chat-view:window-main',
	type: 'chat',
	chatId: null,
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

function twoWindowRoot(
	mainTabs: WorkspaceWindowNode['tabs'],
	secondSurfaceId: string,
): DesktopWorkspaceNode {
	return {
		type: 'partition',
		id: 'partition-root',
		direction: 'horizontal',
		ratio: 0.5,
		children: [
			{ type: 'window', id: 'window-main', tabs: mainTabs },
			{
				type: 'window',
				id: 'window-two',
				tabs: {
					order: [secondSurfaceId],
					activeId: secondSurfaceId,
					mru: [secondSurfaceId],
				},
			},
		],
	};
}

function labelFor(surfaceId: string): string {
	if (surfaceId === chatSurface.id) return 'Chat A';
	if (surfaceId === otherChatSurface.id) return 'Chat B';
	if (surfaceId === gitSurface.id) return 'Git';
	return surfaceId;
}

function renderTitleBar(node: WorkspaceWindowNode, isCurrent = true) {
	return render(WorkspaceWindowTitleBar, {
		workspaceWindow: node,
		labelFor,
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
		runtime.processingChatIds.clear();
		runtime.terminalSessions = [];
		runtime.surfaces = { [chatSurface.id]: chatSurface, [gitSurface.id]: gitSurface };
		vi.stubGlobal('ResizeObserver', undefined);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('shows a draggable tab and direct controls for a one-tab window', () => {
		renderTitleBar(workspaceWindow([chatSurface.id]));

		expect(screen.getByRole('tablist')).toBeTruthy();
		expect(screen.getByRole('tab', { name: 'Chat A' }).getAttribute('draggable')).toBe('true');
		const toolbar = screen.getByRole('toolbar');
		expect(toolbar.classList.contains('relative')).toBe(true);
		expect(toolbar.classList.contains('z-50')).toBe(true);
		expect(toolbar.classList.contains('h-10')).toBe(true);
		expect(toolbar.classList.contains('bg-workspace-window-titlebar')).toBe(true);
		expect(toolbar.classList.contains('bg-workspace-window-titlebar-active')).toBe(false);
		expect(screen.getByRole('button', { name: m.workspace_add_to_window() })).toBeTruthy();
		expect(screen.getByRole('button', { name: m.workspace_window_actions() })).toBeTruthy();
		expect(screen.getByRole('button', { name: m.workspace_fullscreen() })).toBeTruthy();
		expect(screen.queryByRole('button', { name: m.workspace_close_window() })).toBeNull();
	});

	it('keeps an empty Chat tab non-draggable', () => {
		runtime.surfaces = { [emptyChatSurface.id]: emptyChatSurface };
		renderTitleBar(workspaceWindow([emptyChatSurface.id]));

		expect(screen.getByRole('tab', { name: 'Chat A' }).hasAttribute('draggable')).toBe(false);
	});

	it('uses a window-local tablist when multiple tabs exist', () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id));

		const tablist = screen.getByRole('tablist');
		expect(tablist).toBeTruthy();
		expect(screen.getByRole('tab', { name: 'Git' }).getAttribute('aria-selected')).toBe('true');
		expect(screen.getByRole('tab', { name: 'Chat A' }).getAttribute('aria-selected')).toBe('false');
		expect(tablist.closest('header')?.classList.contains('h-10')).toBe(true);
	});

	it('replaces an inactive background Chat tab icon while that Chat is processing', () => {
		runtime.processingChatIds.add('chat-a');
		const { container } = renderTitleBar(
			workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id),
			false,
		);
		const chatTab = screen.getByRole('tab', { name: 'Chat A' });
		const indicator = chatTab.querySelector('[data-slot="workspace-chat-processing-indicator"]');
		const descriptionId = chatTab.getAttribute('aria-describedby');

		expect(indicator).toBeTruthy();
		expect(chatTab.querySelector('.lucide-message-square')).toBeNull();
		expect(descriptionId).toBeTruthy();
		if (!descriptionId) throw new Error('Processing tab has no accessible description');
		expect(document.getElementById(descriptionId)?.textContent).toBe(m.chat_window_processing());
		const measurementTab = container.querySelector(
			`[data-window-tab-measure-id="${chatSurface.id}"]`,
		);
		expect(
			measurementTab?.querySelector('[data-slot="workspace-chat-processing-indicator"]'),
		).toBeNull();
		expect(measurementTab?.querySelector('.lucide-message-square')).toBeTruthy();
	});

	it('uses the normal Chat icon when no processing session is known', () => {
		const { container } = renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id]));
		const chatTab = screen.getByRole('tab', { name: 'Chat A' });

		expect(chatTab.querySelector('[data-slot="workspace-chat-processing-indicator"]')).toBeNull();
		expect(chatTab.querySelector('.lucide-message-square')).toBeTruthy();
		expect(
			container.querySelectorAll('[data-slot="workspace-chat-processing-indicator"]'),
		).toHaveLength(0);
	});

	it('replaces the one-tab Chat icon while processing', () => {
		runtime.processingChatIds.add('chat-a');
		const { container } = renderTitleBar(workspaceWindow([chatSurface.id]));

		const chatTab = screen.getByRole('tab', { name: 'Chat A' });
		expect(chatTab.querySelector('[data-slot="workspace-chat-processing-indicator"]')).toBeTruthy();
		expect(chatTab.querySelector('.lucide-message-square')).toBeNull();
		expect(
			container.querySelector(
				`[data-window-tab-measure-id="${chatSurface.id}"] .lucide-message-square`,
			),
		).toBeTruthy();
	});

	it('leaves the sole selected tab transparent in current and inactive windows', () => {
		runtime.windowCount = 2;
		const currentRender = renderTitleBar(workspaceWindow([chatSurface.id]));
		const current = currentRender.container.querySelector('[data-workspace-window-titlebar]')!;
		expect(current.classList.contains('bg-workspace-window-titlebar-active')).toBe(true);
		expect(
			currentRender
				.getByRole('tab', { name: 'Chat A' })
				.classList.contains('bg-workspace-window-tab-selected'),
		).toBe(false);
		cleanup();

		const inactiveRender = renderTitleBar(workspaceWindow([chatSurface.id]), false);
		const inactive = inactiveRender.container.querySelector('[data-workspace-window-titlebar]')!;
		expect(inactive.classList.contains('bg-workspace-window-titlebar')).toBe(true);
		expect(inactive.classList.contains('bg-workspace-window-titlebar-active')).toBe(false);
		expect(
			inactiveRender
				.getByRole('tab', { name: 'Chat A' })
				.classList.contains('bg-workspace-window-tab-selected-inactive'),
		).toBe(false);
	});

	it('uses current and inactive selected-tab tokens when a window has multiple tabs', () => {
		runtime.windowCount = 2;
		const currentRender = renderTitleBar(
			workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id),
		);
		expect(
			currentRender
				.getByRole('tab', { name: 'Git' })
				.classList.contains('bg-workspace-window-tab-selected'),
		).toBe(true);
		cleanup();

		const inactiveRender = renderTitleBar(
			workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id),
			false,
		);
		expect(
			inactiveRender
				.getByRole('tab', { name: 'Git' })
				.classList.contains('bg-workspace-window-tab-selected-inactive'),
		).toBe(true);
	});

	it('keeps the fullscreen title bar muted', () => {
		runtime.windowCount = 2;
		runtime.fullscreenWindowId = 'window-main';
		const toolbar = renderTitleBar(workspaceWindow([chatSurface.id])).container.querySelector(
			'[data-workspace-window-titlebar]',
		)!;

		expect(toolbar.classList.contains('bg-workspace-window-titlebar')).toBe(true);
		expect(toolbar.classList.contains('bg-workspace-window-titlebar-active')).toBe(false);
	});

	it('describes the final Chat view close block', () => {
		runtime.windowCount = 2;
		const close = renderTitleBar(workspaceWindow([chatSurface.id])).getByRole('button', {
			name: m.workspace_close_window(),
		});

		expect(close.title).toBe(m.workspace_close_window_final_chat_disabled());
	});

	it('describes a transient close block when another Chat view remains', () => {
		runtime.windowCount = 2;
		runtime.surfaces = {
			[chatSurface.id]: chatSurface,
			[gitSurface.id]: gitSurface,
			[otherChatSurface.id]: otherChatSurface,
		};
		runtime.desktopRoot = {
			type: 'partition',
			id: 'partition-root',
			direction: 'horizontal',
			ratio: 0.5,
			children: [
				workspaceWindow([chatSurface.id]),
				{
					type: 'window',
					id: 'window-two',
					tabs: {
						order: [otherChatSurface.id],
						activeId: otherChatSurface.id,
						mru: [otherChatSurface.id],
					},
				},
			],
		};

		const close = renderTitleBar(workspaceWindow([chatSurface.id])).getByRole('button', {
			name: m.workspace_close_window(),
		});

		expect(close.title).toBe(m.workspace_close_window_unavailable());
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

	it('keeps all available view commands in canonical order before open terminals', async () => {
		const kinds = [
			'git',
			'git-history',
			'git-compare',
			'pull-requests',
			'files',
			'commit',
		] as const;
		runtime.surfaces = Object.fromEntries(
			[chatSurface, ...kinds.map((kind) => portableSingletonDescriptor(kind))].map((surface) => [
				surface.id,
				surface,
			]),
		);
		runtime.terminalSessions = [{ metadata: { terminalId: 'terminal-seven', displaySequence: 7 } }];
		renderTitleBar(workspaceWindow([chatSurface.id]));

		await fireEvent.click(screen.getByRole('button', { name: m.workspace_add_to_window() }));

		expect(screen.getByText(m.workspace_open_views())).toBeTruthy();
		const items = screen.getAllByRole('menuitem');
		const viewLabels = [
			m.workspace_open_surface({ surface: m.workspace_surface_git_workbench() }),
			m.workspace_open_git_history(),
			m.workspace_open_git_compare(),
			m.workspace_open_surface({ surface: m.workspace_surface_pull_requests() }),
			m.workspace_open_surface({ surface: m.workspace_surface_files() }),
			m.workspace_open_surface({ surface: m.workspace_surface_commit() }),
		];
		const viewItems = viewLabels.map((label) => screen.getByRole('menuitem', { name: label }));
		const terminal = screen.getByRole('menuitem', {
			name: m.workspace_surface_terminal_number({ number: 7 }),
		});

		expect(viewItems.map((item) => items.indexOf(item))).toEqual([1, 2, 3, 4, 5, 6]);
		expect(items.indexOf(viewItems.at(-1)!)).toBeLessThan(items.indexOf(terminal));
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
			'move-new-left',
			'move-new-right',
			'move-new-top',
			'move-new-bottom',
			'close-tab',
		]);
		const separator = menu.querySelector('[data-workspace-window-tab-actions-separator]');
		expect(separator).toBeTruthy();
		expect(actions.at(-1)?.nextElementSibling).toBe(separator);
		expect(actions.at(-1)?.getAttribute('data-variant')).toBe('default');

		await fireEvent.click(screen.getByRole('menuitem', { name: m.workspace_move_tab_left() }));
		expect(moveTabToWindow).toHaveBeenCalledWith(gitSurface.id, 'window-main', 0);
	});

	it('moves Chat directionally from the current-tab menu', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id]));
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));
		await fireEvent.click(
			screen.getByRole('menuitem', { name: m.workspace_move_tab_to_new_window_right() }),
		);

		expect(moveTabToNewWindow).toHaveBeenCalledWith(chatSurface.id, 'window-main', 'right');
	});

	it('offers every other window as a Chat move destination', async () => {
		const node = workspaceWindow([chatSurface.id, gitSurface.id]);
		runtime.windowCount = 2;
		runtime.desktopRoot = twoWindowRoot(node.tabs, otherChatSurface.id);
		runtime.surfaces = {
			[chatSurface.id]: chatSurface,
			[gitSurface.id]: gitSurface,
			[otherChatSurface.id]: otherChatSurface,
		};
		renderTitleBar(node);
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));
		await fireEvent.click(
			screen.getByRole('menuitem', {
				name: m.workspace_move_to_window({ window: 'Chat B' }),
			}),
		);

		expect(moveTabToWindow).toHaveBeenCalledWith(chatSurface.id, 'window-two', undefined);

		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat A' }));
		await fireEvent.click(
			await screen.findByRole('menuitem', {
				name: m.workspace_move_to_window({ window: 'Chat B' }),
			}),
		);
		expect(moveTabToWindow).toHaveBeenCalledTimes(2);
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

	it('moves Chat directionally from the tab context menu', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id]));
		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat A' }));
		await fireEvent.click(
			await screen.findByRole('menuitem', {
				name: m.workspace_move_tab_to_new_window_right(),
			}),
		);

		await waitFor(() =>
			expect(moveTabToNewWindow).toHaveBeenCalledWith(chatSurface.id, 'window-main', 'right'),
		);
	});

	it('keeps neutral Close Tab directly after directional actions in the context menu', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id));
		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Git' }));
		const below = await screen.findByRole('menuitem', {
			name: m.workspace_move_tab_to_new_window_below(),
		});
		const close = screen.getByRole('menuitem', { name: m.workspace_close_tab() });

		expect(below.nextElementSibling).toBe(close);
		expect(close.getAttribute('data-variant')).toBe('default');
	});

	it('disables directional new-window actions in both tab menus at the window cap', async () => {
		const node = workspaceWindow([chatSurface.id, gitSurface.id]);
		const directionalActionLabels = [
			m.workspace_move_tab_to_new_window_left(),
			m.workspace_move_tab_to_new_window_right(),
			m.workspace_move_tab_to_new_window_above(),
			m.workspace_move_tab_to_new_window_below(),
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
				screen.queryByRole('menuitem', {
					name: m.workspace_move_tab_to_new_window_right(),
				}),
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
