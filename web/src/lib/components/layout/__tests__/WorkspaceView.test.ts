import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import ConversationWorkspaceStub from './ConversationWorkspaceStub.svelte';
import SplitContainerStub from './SplitContainerStub.svelte';

vi.mock('$lib/components/chat/ConversationWorkspace.svelte', () => ({
	default: ConversationWorkspaceStub
}));

vi.mock('$lib/components/split/SplitContainer.svelte', () => ({
	default: SplitContainerStub
}));

import WorkspaceViewTestHarness from './WorkspaceViewTestHarness.svelte';

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

describe('WorkspaceView header visibility', () => {
	it('hides the top header on desktop when Show header is disabled on the chat tab', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: false,
			alwaysFullscreenOnGitPanel: true,
			isMobile: false
		});

		expect(screen.queryByRole('heading', { name: 'Header Test Chat' })).toBeNull();
		expect(container.querySelector('.absolute .bg-chat-tabs-rail')).toBeTruthy();
		expect(screen.getByTitle('Fullscreen')).toBeTruthy();
	});

	it('keeps the top header visible on desktop when Show header is disabled on non-chat tabs', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'preview',
			showChatHeader: false,
			isMobile: false
		});

		expect(screen.getByRole('heading', { name: 'Header Test Chat' })).toBeTruthy();
		expect(container.querySelector('.absolute .bg-chat-tabs-rail')).toBeNull();
	});

	it('hides the top header on mobile chat tab when Show header is disabled', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: false,
			isMobile: true
		});

		expect(screen.queryByRole('heading', { name: 'Header Test Chat' })).toBeNull();
		expect(screen.queryByLabelText('Open menu')).toBeNull();
		expect(container.querySelector('.absolute .bg-chat-tabs-rail')).toBeNull();
		expect(screen.queryByTitle('Fullscreen')).toBeNull();
	});

	it('shows the top header when Show header is enabled', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: true,
			alwaysFullscreenOnGitPanel: true,
			isMobile: false
		});

		expect(screen.getByRole('heading', { name: 'Header Test Chat' })).toBeTruthy();
		expect(container.querySelector('.absolute .bg-chat-tabs-rail')).toBeNull();
		expect(screen.getByTitle('Fullscreen')).toBeTruthy();
	});

	it('shows exit fullscreen title when desktop fullscreen is active', () => {
		render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: true,
			alwaysFullscreenOnGitPanel: true,
			isMobile: false,
			isDesktopFullscreen: true
		});

		expect(screen.getByTitle('Exit fullscreen')).toBeTruthy();
	});

	it('hides fullscreen control on git tab when always-fullscreen-on-git is enabled', () => {
		render(WorkspaceViewTestHarness, {
			activeTab: 'git',
			showChatHeader: true,
			alwaysFullscreenOnGitPanel: true,
			isMobile: false
		});

		expect(screen.queryByTitle('Fullscreen')).toBeNull();
	});

	it('shows fullscreen control on git tab when always-fullscreen-on-git is disabled', () => {
		render(WorkspaceViewTestHarness, {
			activeTab: 'git',
			showChatHeader: true,
			alwaysFullscreenOnGitPanel: false,
			isMobile: false
		});

		expect(screen.getByTitle('Fullscreen')).toBeTruthy();
	});

	it('uses semantic token classes for header and active tabs', () => {
		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: true,
			isMobile: false
		});

		expect(container.querySelector('.bg-chat-header')).toBeTruthy();
		expect(container.querySelector('.bg-chat-tabs-rail')).toBeTruthy();
		expect(container.querySelector('.bg-chat-tabs-active')).toBeTruthy();
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

		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: true,
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

		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: true,
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

		const { container } = render(WorkspaceViewTestHarness, {
			activeTab: 'chat',
			showChatHeader: true,
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
