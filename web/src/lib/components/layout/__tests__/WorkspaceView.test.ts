import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import ConversationWorkspaceStub from './ConversationWorkspaceStub.svelte';
import SplitContainerStub from './SplitContainerStub.svelte';

vi.mock('$lib/components/chat/ConversationWorkspace.svelte', () => ({
	default: ConversationWorkspaceStub,
}));

vi.mock('$lib/components/split/SplitContainer.svelte', () => ({
	default: SplitContainerStub,
}));

import WorkspaceViewTestHost from './WorkspaceViewTestHost.svelte';

function dispatchDragEvent(
	target: HTMLElement,
	type: 'dragover' | 'drop',
	position: { clientX: number; clientY: number },
): void {
	const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, 'clientX', { value: position.clientX });
	Object.defineProperty(event, 'clientY', { value: position.clientY });
	Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: 'move' } });
	target.dispatchEvent(event);
}

function makeChatSessions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		selectedChat: null,
		byId: {},
		orderedChats: [],
		isLoadingChats: false,
		setSelectedChatId: vi.fn(),
		quietRefreshChats: vi.fn(),
		deleteRemoteChat: vi.fn(),
		...overrides,
	};
}

async function openCurrentChatMenu(label = 'Chat actions'): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('WorkspaceView empty selection states', () => {
	it('shows loading state while chats are loading and no chat is selected', () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			chatSessions: makeChatSessions({ isLoadingChats: true }),
		});

		expect(screen.getByRole('status').textContent).toContain('Loading chats...');
		expect(screen.queryByRole('heading', { name: 'No chat selected' })).toBeNull();
	});

	it('shows the empty state after chats load with no selected chat', () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			chatSessions: makeChatSessions(),
		});

		expect(screen.getByRole('heading', { name: 'No chat selected' })).toBeTruthy();
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('keeps the selected workspace visible during background chat-list loads', () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			chatSessions: makeChatSessions({
				isLoadingChats: true,
				selectedChat: {
					id: 'chat-1',
					title: 'Header Test Chat',
					projectPath: '/tmp/header-test',
				},
			}),
		});

		expect(screen.getByTestId('conversation-workspace-stub')).toBeTruthy();
		expect(screen.queryByRole('status')).toBeNull();
	});
});

describe('WorkspaceView header visibility', () => {
	it('hides the top header on desktop for the chat tab', () => {
		const { container } = render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
		});

		expect(screen.queryByRole('heading', { name: 'Header Test Chat' })).toBeNull();
		expect(container.querySelector('.absolute .bg-chat-tabs-rail')).toBeTruthy();
		const toolbar = container.querySelector<HTMLElement>('[data-floating-workspace-toolbar]');
		expect(toolbar).toBeTruthy();
		expect(toolbar?.className).toContain('top-2');
		expect(toolbar?.className).not.toContain('top-3');
		expect(toolbar?.className).toContain('right-3');
		expect(toolbar?.className).not.toContain('right-6');
		expect(toolbar?.className).not.toContain('md:right-8');
		expect(screen.getByRole('button', { name: 'Chat' }).className).toContain('h-8');
		expect(screen.getByRole('button', { name: 'Chat actions' }).className).toContain('h-8');
		expect(
			screen.getByTestId('conversation-workspace-stub').dataset.reserveTopFloatingToolbar,
		).toBe('true');
		expect(screen.getByRole('button', { name: 'Chat actions' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
	});

	it('keeps the top header visible on desktop for non-chat tabs', () => {
		const { container } = render(WorkspaceViewTestHost, {
			activeTab: 'files',
			isMobile: false,
		});

		expect(screen.getByRole('heading', { name: 'Header Test Chat' })).toBeTruthy();
		const toolbar = container.querySelector<HTMLElement>('[data-floating-workspace-toolbar]');
		expect(toolbar).toBeTruthy();
		expect(toolbar?.className).toContain('top-2');
		expect(toolbar?.className).toContain('right-3');
		expect(toolbar?.className).not.toContain('right-6');
		expect(toolbar?.className).not.toContain('md:right-8');
	});

	it('keeps the desktop floating toolbar anchored across tab changes', async () => {
		const { container, rerender } = render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
		});
		const initialClass = container.querySelector<HTMLElement>(
			'[data-floating-workspace-toolbar]',
		)?.className;

		await rerender({
			activeTab: 'files',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
		});

		expect(container.querySelector<HTMLElement>('[data-floating-workspace-toolbar]')?.className).toBe(
			initialClass,
		);
	});

	it('lowers the desktop floating toolbar only while split chat panes are visible', async () => {
		const splitLayout = {
			isEnabled: true,
			root: {
				type: 'split',
				direction: 'horizontal',
				ratio: 0.5,
				children: [
					{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
					{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
				],
			},
			focusedPaneId: 'pane-left',
			draggedChatId: null,
			draggedPaneId: null,
			paneCount: 2,
			panes: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
			focusedChatId: 'chat-1',
			focusPane: vi.fn(),
			replacePaneChat: vi.fn(),
			swapPanes: vi.fn(),
			closePane: vi.fn(),
			addChatToZone: vi.fn(),
			endDrag: vi.fn(),
			setRatioByPath: vi.fn(),
			disable: vi.fn(),
			enableWithChat: vi.fn(),
			setGrid: vi.fn(),
			splitPane: vi.fn(),
		};
		const { container, rerender } = render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
			splitLayout,
		});

		const toolbar = container.querySelector<HTMLElement>('[data-floating-workspace-toolbar]');
		expect(toolbar?.className).toContain('top-8');
		expect(toolbar?.className).not.toContain('top-2');

		await rerender({
			activeTab: 'git',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
			splitLayout,
		});

		expect(container.querySelector<HTMLElement>('[data-floating-workspace-toolbar]')?.className).toContain(
			'top-2',
		);
		expect(
			container.querySelector<HTMLElement>('[data-floating-workspace-toolbar]')?.className,
		).not.toContain('top-8');
	});

	it('keeps the split workspace mounted when switching away from chat tab', async () => {
		const root = {
			type: 'split',
			direction: 'horizontal',
			ratio: 0.5,
			children: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
		};
		const splitLayout = {
			isEnabled: true,
			root,
			focusedPaneId: 'pane-left',
			draggedChatId: null,
			draggedPaneId: null,
			paneCount: 2,
			panes: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
			focusedChatId: 'chat-1',
			focusPane: vi.fn(),
			replacePaneChat: vi.fn(),
			swapPanes: vi.fn(),
			closePane: vi.fn(),
			addChatToZone: vi.fn(),
			endDrag: vi.fn(),
			setRatioByPath: vi.fn(),
			disable: vi.fn(),
			enableWithChat: vi.fn(),
			setGrid: vi.fn(),
			splitPane: vi.fn(),
		};

		const { container, rerender } = render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
			splitLayout,
		});
		const splitContainer = screen.getByTestId('split-container-stub');
		await tick();
		const focusedOverlay = container.querySelector<HTMLElement>('[data-focused-split-overlay]');
		expect(focusedOverlay?.className).toContain('rounded-b-lg');
		expect(focusedOverlay?.className).not.toContain('border');

		await rerender({
			activeTab: 'git',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
			splitLayout,
		});

		expect(screen.getByTestId('split-container-stub')).toBe(splitContainer);
		expect(splitContainer.closest('.hidden')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-pressed')).toBe('true');
	});

	it('maximizes a split pane by exiting split view and selecting that chat', async () => {
		const disable = vi.fn();
		const setSelectedChatId = vi.fn();
		const deleteRemoteChat = vi.fn();
		const root = {
			type: 'split',
			direction: 'horizontal',
			ratio: 0.5,
			children: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
		};
		const splitLayout = {
			isEnabled: true,
			root,
			focusedPaneId: 'pane-left',
			draggedChatId: null,
			draggedPaneId: null,
			paneCount: 2,
			panes: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
			focusedChatId: 'chat-1',
			focusPane: vi.fn(),
			replacePaneChat: vi.fn(),
			swapPanes: vi.fn(),
			closePane: vi.fn(),
			addChatToZone: vi.fn(),
			endDrag: vi.fn(),
			setRatioByPath: vi.fn(),
			disable,
			enableWithChat: vi.fn(),
			setGrid: vi.fn(),
			splitPane: vi.fn(),
		};

		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			splitLayout,
			chatSessions: makeChatSessions({
				selectedChat: {
					id: 'chat-1',
					title: 'Header Test Chat',
					projectPath: '/tmp/header-test',
				},
				byId: {
					'chat-1': {
						id: 'chat-1',
						title: 'Header Test Chat',
						projectPath: '/tmp/header-test',
					},
					'chat-2': {
						id: 'chat-2',
						title: 'Right Pane Chat',
						projectPath: '/tmp/header-test',
					},
				},
				setSelectedChatId,
				deleteRemoteChat,
			}),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Maximize pane showing chat-2' }));

		expect(disable).toHaveBeenCalledOnce();
		expect(setSelectedChatId).toHaveBeenCalledWith('chat-2');
		expect(deleteRemoteChat).not.toHaveBeenCalled();
	});

	it('hides the top header on mobile chat tab', () => {
		const { container } = render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: true,
		});

		expect(screen.queryByRole('heading', { name: 'Header Test Chat' })).toBeNull();
		expect(screen.queryByLabelText('Open menu')).toBeNull();
		expect(container.querySelector('[data-floating-workspace-toolbar]')).toBeNull();
		expect(container.querySelector('[data-mobile-current-chat-menu]')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Options' })).toBeNull();
		const settingsButton = screen.getByRole('button', { name: 'Settings' });
		expect(settingsButton).toBeTruthy();
		expect(settingsButton.className).toContain('h-8');
		expect(settingsButton.className).toContain('w-8');
		expect(settingsButton.className).toContain('px-0');
		expect(settingsButton.className).toContain('text-sm');
		expect(settingsButton.firstElementChild?.classList.contains('lucide-settings')).toBe(true);
		expect(settingsButton.textContent?.trim()).toBe('');
		expect(screen.queryByRole('button', { name: 'Chat actions' })).toBeNull();
	});

	it('shows exit fullscreen label when desktop fullscreen is active', async () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
			isDesktopFullscreen: true,
		});

		await openCurrentChatMenu();
		expect(await screen.findByRole('menuitem', { name: 'Exit fullscreen' })).toBeTruthy();
	});

	it('hides fullscreen control on git tab when always-fullscreen-on-git is enabled', () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'git',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
		});

		expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
	});

	it('keeps the chat workspace mounted but marks it hidden on non-chat tabs', () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'git',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
		});

		expect(screen.getByTestId('conversation-workspace-stub').dataset.isVisible).toBe('false');
	});

	it('shows fullscreen control on git tab when always-fullscreen-on-git is disabled', async () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'git',
			alwaysFullscreenOnGitPanel: false,
			isMobile: false,
		});

		await openCurrentChatMenu();
		expect(await screen.findByRole('menuitem', { name: 'Fullscreen' })).toBeTruthy();
	});

	it('hides split view from the desktop overflow menu off the chat tab', async () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'files',
			alwaysFullscreenOnGitPanel: false,
			isMobile: false,
		});

		await openCurrentChatMenu();

		expect(screen.queryByRole('menuitem', { name: 'Split view' })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: 'Reload from native history' })).toBeNull();
		expect(await screen.findByRole('menuitem', { name: 'Fullscreen' })).toBeTruthy();
		expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeTruthy();
	});

	it('exposes short labels on every desktop toolbar action', () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
		});

		for (const label of ['Chat', 'Git', 'Files', 'Terminal', 'Chat actions']) {
			expect(screen.getByRole('button', { name: label })).toBeTruthy();
		}
		for (const label of ['Split view', 'Share', 'Fullscreen']) {
			expect(screen.queryByRole('button', { name: label })).toBeNull();
		}
	});

	it('exposes current chat actions from the desktop overflow menu', async () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
		});

		await openCurrentChatMenu();

		const labels = (await screen.findAllByRole('menuitem')).map((item) =>
			item.textContent?.trim(),
		);
		expect(labels).toEqual([
			'Split view',
			'Fullscreen',
			'Share',
			'Details',
			'Rename',
			'Fork',
			'Change project path',
			'Reload from native history',
			'Delete',
		]);
	});

	it('omits split and fullscreen from the mobile current chat menu', async () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: true,
		});

		await openCurrentChatMenu('Settings');

		expect(screen.queryByRole('menuitem', { name: 'Split view' })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: 'Fullscreen' })).toBeNull();
		const labels = (await screen.findAllByRole('menuitem')).map((item) =>
			item.textContent?.trim(),
		);
		expect(labels).toEqual([
			'Share',
			'Details',
			'Rename',
			'Fork',
			'Change project path',
			'Reload from native history',
			'Delete',
		]);
	});

	it('hides whole-chat fork from the current chat menu when unsupported', async () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			supportsFork: false,
		});

		await openCurrentChatMenu();

		expect(screen.queryByRole('menuitem', { name: 'Fork' })).toBeNull();
	});

	it('disables processing-sensitive current chat actions while the chat is processing', async () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			chatSessions: makeChatSessions({
				selectedChat: {
					id: 'chat-1',
					title: 'Header Test Chat',
					projectPath: '/tmp/header-test',
					isProcessing: true,
				},
			}),
		});

		await openCurrentChatMenu();

		expect(
			screen.getByRole('menuitem', { name: 'Reload from native history' }).hasAttribute('data-disabled'),
		).toBe(true);
		expect(
			screen.getByRole('menuitem', { name: 'Change project path' }).hasAttribute('data-disabled'),
		).toBe(true);
		expect(screen.getByRole('menuitem', { name: 'Fork' }).hasAttribute('data-disabled')).toBe(
			true,
		);
	});

	it('keeps current chat fork enabled while processing when running fork is supported', async () => {
		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			supportsForkWhileRunning: true,
			chatSessions: makeChatSessions({
				selectedChat: {
					id: 'chat-1',
					title: 'Header Test Chat',
					projectPath: '/tmp/header-test',
					isProcessing: true,
				},
			}),
		});

		await openCurrentChatMenu();

		expect(screen.getByRole('menuitem', { name: 'Fork' }).hasAttribute('data-disabled')).toBe(
			false,
		);
	});

	it('dispatches current chat action callbacks from the overflow menu', async () => {
		const chatActions = {
			requestDelete: vi.fn(),
			requestRename: vi.fn(),
			requestDetails: vi.fn(),
			requestShare: vi.fn(),
			requestProjectPath: vi.fn(),
			fork: vi.fn(),
			reload: vi.fn(),
		};

		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			chatActions,
		});

		await openCurrentChatMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
		await openCurrentChatMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Details' }));
		await openCurrentChatMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Reload from native history' }));
		await openCurrentChatMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }));
		await openCurrentChatMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Fork' }));
		await openCurrentChatMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Change project path' }));
		await openCurrentChatMenu();
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

		expect(chatActions.requestRename).toHaveBeenCalledOnce();
		expect(chatActions.requestDetails).toHaveBeenCalledOnce();
		expect(chatActions.reload).toHaveBeenCalledOnce();
		expect(chatActions.requestShare).toHaveBeenCalledOnce();
		expect(chatActions.fork).toHaveBeenCalledOnce();
		expect(chatActions.requestProjectPath).toHaveBeenCalledOnce();
		expect(chatActions.requestDelete).toHaveBeenCalledOnce();
	});

	it('uses semantic token classes for header and active tabs', () => {
		const { container } = render(WorkspaceViewTestHost, {
			activeTab: 'files',
			isMobile: false,
		});

		expect(container.querySelector('.bg-chat-header')).toBeTruthy();
		expect(container.querySelector('.bg-chat-tabs-rail')).toBeTruthy();
		expect(container.querySelector('.bg-chat-tabs-active')).toBeTruthy();
	});

	it('uses compact transcript scale for two split panes', () => {
		const root = {
			type: 'split',
			direction: 'horizontal',
			ratio: 0.5,
			children: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
		};
		const splitLayout = {
			isEnabled: true,
			root,
			focusedPaneId: 'pane-left',
			draggedChatId: null,
			draggedPaneId: null,
			paneCount: 2,
			panes: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
			focusedChatId: 'chat-1',
			focusPane: vi.fn(),
			replacePaneChat: vi.fn(),
			swapPanes: vi.fn(),
			closePane: vi.fn(),
			addChatToZone: vi.fn(),
			endDrag: vi.fn(),
			setRatioByPath: vi.fn(),
			disable: vi.fn(),
			enableWithChat: vi.fn(),
			setGrid: vi.fn(),
			splitPane: vi.fn(),
		};

		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			splitLayout,
		});

		expect(screen.getByTestId('split-container-stub').dataset.textScale).toBe('0.85');
	});

	it('uses dense transcript scale for four split panes', () => {
		const root = {
			type: 'split',
			direction: 'horizontal',
			ratio: 0.5,
			children: [
				{
					type: 'split',
					direction: 'vertical',
					ratio: 0.5,
					children: [
						{ type: 'pane', id: 'pane-1', chatId: 'chat-1' },
						{ type: 'pane', id: 'pane-2', chatId: 'chat-2' },
					],
				},
				{
					type: 'split',
					direction: 'vertical',
					ratio: 0.5,
					children: [
						{ type: 'pane', id: 'pane-3', chatId: 'chat-3' },
						{ type: 'pane', id: 'pane-4', chatId: 'chat-4' },
					],
				},
			],
		};
		const splitLayout = {
			isEnabled: true,
			root,
			focusedPaneId: 'pane-1',
			draggedChatId: null,
			draggedPaneId: null,
			paneCount: 4,
			panes: [
				{ type: 'pane', id: 'pane-1', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-2', chatId: 'chat-2' },
				{ type: 'pane', id: 'pane-3', chatId: 'chat-3' },
				{ type: 'pane', id: 'pane-4', chatId: 'chat-4' },
			],
			focusedChatId: 'chat-1',
			focusPane: vi.fn(),
			replacePaneChat: vi.fn(),
			swapPanes: vi.fn(),
			closePane: vi.fn(),
			addChatToZone: vi.fn(),
			endDrag: vi.fn(),
			setRatioByPath: vi.fn(),
			disable: vi.fn(),
			enableWithChat: vi.fn(),
			setGrid: vi.fn(),
			splitPane: vi.fn(),
		};

		render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			splitLayout,
		});

		expect(screen.getByTestId('split-container-stub').dataset.textScale).toBe('0.7');
	});

	it('accepts sidebar chat drops while split mode is already active', async () => {
		const addChatToZone = vi.fn();
		const endDrag = vi.fn();
		const setSelectedChatId = vi.fn();
		const root = {
			type: 'split',
			direction: 'horizontal',
			ratio: 0.5,
			children: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
		};
		const splitLayout = {
			isEnabled: true,
			root,
			focusedPaneId: 'pane-left',
			draggedChatId: 'chat-3',
			draggedPaneId: null,
			panes: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
			focusedChatId: 'chat-1',
			addChatToZone,
			endDrag,
			focusPane: vi.fn(),
			replacePaneChat: vi.fn(),
			swapPanes: vi.fn(),
			closePane: vi.fn(),
			setRatioByPath: vi.fn(),
			disable: vi.fn(),
			enableWithChat: vi.fn(),
			setGrid: vi.fn(),
			splitPane: vi.fn(),
		};

		const { container } = render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			splitLayout,
			chatSessions: {
				selectedChat: {
					id: 'chat-1',
					title: 'Header Test Chat',
					projectPath: '/tmp/header-test',
				},
				byId: {},
				orderedChats: [],
				setSelectedChatId,
			},
		});

		const rightPane = container.querySelector<HTMLElement>('[data-pane-id="pane-right"]');
		const layer = container.querySelector<HTMLElement>('[data-split-drag-layer]');
		expect(rightPane).toBeTruthy();
		expect(layer).toBeTruthy();

		Object.defineProperty(rightPane!, 'getBoundingClientRect', {
			value: () => ({
				left: 100,
				top: 0,
				right: 200,
				bottom: 100,
				width: 100,
				height: 100,
				x: 100,
				y: 0,
				toJSON: () => ({}),
			}),
		});

		dispatchDragEvent(layer!, 'dragover', { clientX: 195, clientY: 50 });
		dispatchDragEvent(layer!, 'drop', { clientX: 195, clientY: 50 });

		expect(addChatToZone).toHaveBeenCalledWith('pane-right', 'chat-3', 'right');
		expect(endDrag).toHaveBeenCalledOnce();
		expect(setSelectedChatId).toHaveBeenCalledWith('chat-1');
	});

	it('focuses an existing split pane instead of duplicating a sidebar chat', async () => {
		const addChatToZone = vi.fn();
		const endDrag = vi.fn();
		const focusPane = vi.fn();
		const setSelectedChatId = vi.fn();
		const root = {
			type: 'split',
			direction: 'horizontal',
			ratio: 0.5,
			children: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
		};
		const splitLayout = {
			isEnabled: true,
			root,
			focusedPaneId: 'pane-left',
			draggedChatId: 'chat-2',
			draggedPaneId: null,
			paneCount: 2,
			panes: [
				{ type: 'pane', id: 'pane-left', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-right', chatId: 'chat-2' },
			],
			focusedChatId: 'chat-2',
			addChatToZone,
			endDrag,
			focusPane,
			replacePaneChat: vi.fn(),
			swapPanes: vi.fn(),
			closePane: vi.fn(),
			setRatioByPath: vi.fn(),
			disable: vi.fn(),
			enableWithChat: vi.fn(),
			setGrid: vi.fn(),
			splitPane: vi.fn(),
		};

		const { container } = render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			splitLayout,
			chatSessions: {
				selectedChat: {
					id: 'chat-1',
					title: 'Header Test Chat',
					projectPath: '/tmp/header-test',
				},
				byId: {},
				orderedChats: [],
				setSelectedChatId,
			},
		});

		const rightPane = container.querySelector<HTMLElement>('[data-pane-id="pane-right"]');
		const layer = container.querySelector<HTMLElement>('[data-split-drag-layer]');
		expect(rightPane).toBeTruthy();
		expect(layer).toBeTruthy();

		Object.defineProperty(rightPane!, 'getBoundingClientRect', {
			value: () => ({
				left: 100,
				top: 0,
				right: 200,
				bottom: 100,
				width: 100,
				height: 100,
				x: 100,
				y: 0,
				toJSON: () => ({}),
			}),
		});

		dispatchDragEvent(layer!, 'dragover', { clientX: 195, clientY: 50 });
		await tick();
		expect(screen.getByText('Already open')).toBeTruthy();

		dispatchDragEvent(layer!, 'drop', { clientX: 195, clientY: 50 });

		expect(addChatToZone).not.toHaveBeenCalled();
		expect(focusPane).toHaveBeenCalledWith('pane-right');
		expect(endDrag).toHaveBeenCalledOnce();
		expect(setSelectedChatId).toHaveBeenCalledWith('chat-2');
	});

	it('blocks edge drops when split view already has four panes', async () => {
		const addChatToZone = vi.fn();
		const endDrag = vi.fn();
		const root = {
			type: 'split',
			direction: 'horizontal',
			ratio: 0.5,
			children: [
				{
					type: 'split',
					direction: 'vertical',
					ratio: 0.5,
					children: [
						{ type: 'pane', id: 'pane-1', chatId: 'chat-1' },
						{ type: 'pane', id: 'pane-2', chatId: 'chat-2' },
					],
				},
				{
					type: 'split',
					direction: 'vertical',
					ratio: 0.5,
					children: [
						{ type: 'pane', id: 'pane-3', chatId: 'chat-3' },
						{ type: 'pane', id: 'pane-4', chatId: 'chat-4' },
					],
				},
			],
		};
		const splitLayout = {
			isEnabled: true,
			root,
			focusedPaneId: 'pane-1',
			draggedChatId: 'chat-5',
			draggedPaneId: null,
			paneCount: 4,
			panes: [
				{ type: 'pane', id: 'pane-1', chatId: 'chat-1' },
				{ type: 'pane', id: 'pane-2', chatId: 'chat-2' },
				{ type: 'pane', id: 'pane-3', chatId: 'chat-3' },
				{ type: 'pane', id: 'pane-4', chatId: 'chat-4' },
			],
			focusedChatId: 'chat-1',
			addChatToZone,
			endDrag,
			focusPane: vi.fn(),
			replacePaneChat: vi.fn(),
			swapPanes: vi.fn(),
			closePane: vi.fn(),
			setRatioByPath: vi.fn(),
			disable: vi.fn(),
			enableWithChat: vi.fn(),
			setGrid: vi.fn(),
			splitPane: vi.fn(),
		};

		const { container } = render(WorkspaceViewTestHost, {
			activeTab: 'chat',
			isMobile: false,
			splitLayout,
		});

		const pane = container.querySelector<HTMLElement>('[data-pane-id="pane-4"]');
		const layer = container.querySelector<HTMLElement>('[data-split-drag-layer]');
		expect(pane).toBeTruthy();
		expect(layer).toBeTruthy();

		Object.defineProperty(pane!, 'getBoundingClientRect', {
			value: () => ({
				left: 100,
				top: 100,
				right: 200,
				bottom: 200,
				width: 100,
				height: 100,
				x: 100,
				y: 100,
				toJSON: () => ({}),
			}),
		});

		dispatchDragEvent(layer!, 'dragover', { clientX: 195, clientY: 150 });
		await tick();
		expect(screen.getByText('4 panes max')).toBeTruthy();

		dispatchDragEvent(layer!, 'drop', { clientX: 195, clientY: 150 });

		expect(addChatToZone).not.toHaveBeenCalled();
		expect(endDrag).toHaveBeenCalledOnce();
	});
});
