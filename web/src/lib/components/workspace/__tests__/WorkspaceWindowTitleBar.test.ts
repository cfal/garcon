import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
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
import type { ChatSessionRecord } from '$lib/types/chat-session';
import * as m from '$lib/paraglide/messages.js';

const {
	closeSurface,
	closeWindow,
	createTerminal,
	activateWindow,
	enterWindowFullscreen,
	exitWindowFullscreen,
	focusSurface,
	moveTabToWindow,
	noteWindowChromeFocus,
	openSingletonAsTab,
	moveTabToNewWindow,
	copyToClipboard,
	runtime,
} = vi.hoisted(() => ({
	activateWindow: vi.fn(),
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
	copyToClipboard: vi.fn(async () => true),
	runtime: {
		fullscreenWindowId: null as WorkspaceWindowId | null,
		desktopRoot: null as DesktopWorkspaceNode | null,
		windowCount: 1,
		closeBlocked: true,
		surfaceCloseBlocked: false,
		processingChatIds: new Set<string>(),
		chatSessions: {} as Record<string, Pick<ChatSessionRecord, 'projectPath'>>,
		terminalSessions: [] as Array<{
			metadata: { terminalId: string; displaySequence: number; title: string | null };
		}>,
		surfaces: {} as Record<string, SurfaceDescriptor>,
	},
}));

vi.mock('$lib/utils/clipboard', () => ({ copyToClipboard }));

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
		activateWindow,
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
		get byId() {
			return runtime.chatSessions;
		},
		isChatProcessing: (chatId: string) => runtime.processingChatIds.has(chatId),
	}),
	getNotifications: () => ({ error: vi.fn() }),
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

function renderTitleBar(
	node: WorkspaceWindowNode,
	isCurrent = true,
	resolveLabel: (surfaceId: string) => string = labelFor,
) {
	return render(WorkspaceWindowTitleBar, {
		workspaceWindow: node,
		labelFor: resolveLabel,
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
		runtime.chatSessions = { 'chat-a': { projectPath: '/workspace/project-a' } };
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
		expect(toolbar.classList.contains('bg-workspace-window-titlebar')).toBe(false);
		expect(toolbar.classList.contains('bg-workspace-window-titlebar-active')).toBe(true);
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

	it('adds project path and chat ID rows to Chat tab tooltips', () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id]));

		const chatTab = screen.getByRole('tab', { name: 'Chat A' });
		expect(chatTab.textContent?.trim()).toBe('Chat A');
		expect(chatTab.getAttribute('aria-label')).toBe('Chat A');
		expect(chatTab.getAttribute('title')).toBe(
			'Chat A\n/workspace/project-a\nchat-a',
		);
		expect(screen.getByRole('tab', { name: 'Git' }).getAttribute('title')).toBe('Git');
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

	it('activates the surface from inactive window chrome without hijacking controls', async () => {
		const rendered = renderTitleBar(workspaceWindow([chatSurface.id]), false);
		const toolbar = rendered.getByRole('toolbar');

		await fireEvent.pointerDown(toolbar);
		expect(activateWindow).toHaveBeenCalledWith('window-main');
		expect(noteWindowChromeFocus).not.toHaveBeenCalled();

		activateWindow.mockClear();
		await fireEvent.pointerDown(
			rendered.getByRole('button', { name: m.workspace_add_to_window() }),
		);
		expect(activateWindow).not.toHaveBeenCalled();
		expect(noteWindowChromeFocus).toHaveBeenCalledWith('window-main', chatSurface.id);
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
		runtime.terminalSessions = [
			{ metadata: { terminalId: 'terminal-seven', displaySequence: 7, title: 'Build logs' } },
		];
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
		const terminal = screen.getByRole('menuitem', { name: 'Build logs' });

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

	it('shows standard copy rows below the active Chat tab actions', async () => {
		const fullProjectPath = '/workspace/clients/acme/products/garcon/project-a';
		const displayProjectPath = '…/acme/products/garcon/project-a';
		runtime.chatSessions = { 'chat-a': { projectPath: fullProjectPath } };
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id]));
		const trigger = screen.getByRole('button', { name: m.workspace_window_actions() });
		await fireEvent.click(trigger);

		const menu = document.querySelector<HTMLElement>('[data-workspace-window-menu="window-main"]')!;
		const projectPathItem = within(menu).getByRole('menuitem', {
			name: `${m.workspace_chat_metadata_copy_project_path()}: ${fullProjectPath}`,
		});
		const chatId = within(menu).getByRole('menuitem', {
			name: `${m.workspace_chat_metadata_copy_chat_id()}: chat-a`,
		});
		const lastMovementAction = menu.querySelector(
			'[data-workspace-window-tab-action="move-new-bottom"]',
		);
		const metadataSeparator = menu.querySelector('[data-workspace-chat-metadata-separator]');
		const closeAction = menu.querySelector('[data-workspace-window-tab-action="close-tab"]');
		const tabActionsSeparator = menu.querySelector('[data-workspace-window-tab-actions-separator]');
		const projectPathValue = within(projectPathItem).getByText(displayProjectPath);
		const chatIdValue = within(chatId).getByText('chat-a');

		expect(projectPathItem.textContent).toContain(m.workspace_chat_metadata_copy_project_path());
		expect(projectPathItem.textContent).toContain(displayProjectPath);
		expect(projectPathItem.textContent).not.toContain(fullProjectPath);
		expect(chatId.textContent).toContain(m.workspace_chat_metadata_copy_chat_id());
		expect(chatId.textContent).toContain('chat-a');
		expect(menu.querySelector('[data-workspace-chat-metadata]')).toBeNull();
		expect(projectPathItem.parentElement).toBe(menu);
		expect(lastMovementAction?.nextElementSibling).toBe(closeAction);
		expect(closeAction?.nextElementSibling).toBe(tabActionsSeparator);
		expect(tabActionsSeparator?.nextElementSibling).toBe(projectPathItem);
		expect(projectPathItem.nextElementSibling).toBe(chatId);
		expect(chatId.nextElementSibling).toBe(metadataSeparator);
		expect(projectPathValue.getAttribute('title')).toBe(fullProjectPath);
		expect(chatIdValue.getAttribute('title')).toBe('chat-a');
		expect(projectPathValue.classList).toContain('text-muted-foreground');
		expect(projectPathValue.classList).not.toContain('font-mono');
		expect(chatIdValue.classList).not.toContain('font-mono');

		await fireEvent.click(projectPathItem);
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith(fullProjectPath));
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		await waitFor(() =>
			expect(projectPathItem.getAttribute('title')).toBe(
				m.workspace_chat_metadata_copied({ field: 'Project path' }),
			),
		);

		await fireEvent.click(chatId);
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('chat-a'));
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		await waitFor(() =>
			expect(chatId.getAttribute('title')).toBe(
				m.workspace_chat_metadata_copied({ field: 'Chat ID' }),
			),
		);
	});

	it('closes the active movable tab from the window menu', async () => {
		renderTitleBar(workspaceWindow([chatSurface.id, gitSurface.id], gitSurface.id));
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));
		expect(document.querySelector('[data-workspace-chat-metadata-field]')).toBeNull();
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

	it('keeps long move-destination labels on one truncated line in both tab menus', async () => {
		const node = workspaceWindow([chatSurface.id, gitSurface.id]);
		const destinationTitle =
			'Chat B with a deliberately long title that cannot fit inside the destination menu';
		const moveLabel = m.workspace_move_to_window({ window: destinationTitle });
		const resolveLabel = (surfaceId: string): string =>
			surfaceId === otherChatSurface.id ? destinationTitle : labelFor(surfaceId);
		runtime.windowCount = 2;
		runtime.desktopRoot = twoWindowRoot(node.tabs, otherChatSurface.id);
		runtime.surfaces = {
			[chatSurface.id]: chatSurface,
			[gitSurface.id]: gitSurface,
			[otherChatSurface.id]: otherChatSurface,
		};
		renderTitleBar(node, true, resolveLabel);

		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));
		const actionsItem = screen.getByRole('menuitem', { name: moveLabel });
		const actionsLabel = actionsItem.querySelector('span');
		expect(actionsItem.className).toContain('min-w-0');
		expect(actionsItem.getAttribute('title')).toBe(moveLabel);
		expect(actionsLabel?.className).toContain('truncate');
		expect(actionsLabel?.textContent).toBe(moveLabel);

		await fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('menuitem', { name: moveLabel })).toBeNull());

		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat A' }));
		const contextItem = await screen.findByRole('menuitem', { name: moveLabel });
		const contextLabel = contextItem.querySelector('span');
		expect(contextItem.className).toContain('min-w-0');
		expect(contextItem.getAttribute('title')).toBe(moveLabel);
		expect(contextLabel?.className).toContain('truncate');
		expect(contextLabel?.textContent).toBe(moveLabel);
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
