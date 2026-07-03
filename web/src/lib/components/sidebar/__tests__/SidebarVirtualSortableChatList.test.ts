import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SidebarChatListHost from './SidebarChatListHost.svelte';
import SidebarVirtualSortableChatListHost from './SidebarVirtualSortableChatListHost.svelte';
import {
	CHAT_ROW_SEPARATOR_SLOT_HEIGHT,
	PROJECT_HEADER_ROW_HEIGHT,
	type SidebarVirtualChatRow,
	type SidebarVirtualRow,
} from '../sidebar-virtual-chat-list';
import { sidebarProjectKey } from '../sidebar-row-model';
import type { ChatSessionRecord } from '$lib/types/chat-session';

const rowHeight = 88;

function touchAt(identifier: number, clientX: number, clientY: number) {
	return {
		identifier,
		clientX,
		clientY,
		pageX: clientX,
		pageY: clientY,
		screenX: clientX,
		screenY: clientY,
	};
}

function rect(input: { left: number; top: number; width: number; height: number }): DOMRect {
	return {
		x: input.left,
		y: input.top,
		left: input.left,
		top: input.top,
		width: input.width,
		height: input.height,
		right: input.left + input.width,
		bottom: input.top + input.height,
		toJSON() {
			return this;
		},
	} as DOMRect;
}

function makeChat(index: number, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: `chat-${index}`,
		projectPath: '/tmp/project',
		title: `Chat ${index}`,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'low',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'draft',
		lastMessage: `Chat ${index} preview`,
		tags: [],
		firstMessage: `Chat ${index} first`,
		...overrides,
	};
}

function makeRows(count: number): SidebarVirtualChatRow[] {
	const reorderScopeIds = Array.from({ length: count }, (_, scopeIndex) => `chat-${scopeIndex}`);
	return Array.from({ length: count }, (_, index) => {
		const chat = makeChat(index);
		return {
			type: 'chat' as const,
			key: `normal:${chat.id}`,
			chat,
			list: 'normal' as const,
			isPinned: false,
			isArchived: false,
			projectPath: chat.projectPath,
			reorderScopeKey: 'normal:all',
			reorderScopeIds,
		};
	});
}

function makeScopedRow(index: number, projectPath: string, scopeIds: string[]): SidebarVirtualChatRow {
	const chat = makeChat(index, { projectPath });
	return {
		type: 'chat',
		key: `normal:${chat.id}`,
		chat,
		list: 'normal',
		isPinned: false,
		isArchived: false,
		projectPath: chat.projectPath,
		reorderScopeKey: `normal:project:${projectPath}`,
		reorderScopeIds: scopeIds,
	};
}

function makeProjectHeader(
	projectPath: string,
	count: number,
	chatIds: string[] = [],
	isCollapsed = false,
): SidebarVirtualRow {
	return {
		type: 'project-header',
		key: `project:${sidebarProjectKey(projectPath)}`,
		projectKey: sidebarProjectKey(projectPath),
		projectPath,
		count,
		chatIds,
		isCollapsed,
	};
}

function installTouchGeometry() {
	const viewport = screen.getByTestId('virtual-sidebar-viewport');
	const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
	const row1 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
	if (!row0 || !row1) throw new Error('expected test rows to be rendered');

	vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(
		rect({
			left: 0,
			top: 0,
			width: 320,
			height: 640,
		}),
	);
	vi.spyOn(row0, 'getBoundingClientRect').mockReturnValue(
		rect({
			left: 0,
			top: 0,
			width: 320,
			height: rowHeight,
		}),
	);
	vi.spyOn(row1, 'getBoundingClientRect').mockReturnValue(
		rect({
			left: 0,
			top: rowHeight,
			width: 320,
			height: rowHeight,
		}),
	);
	vi.spyOn(document, 'elementFromPoint').mockImplementation((_, y) =>
		y >= rowHeight ? row1 : row0,
	);

	return { row0, row1, viewport };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('SidebarVirtualSortableChatList', () => {
	it('renders a bounded visible slice for large chat arrays', () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			rowHeight,
		});

		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.queryByText('Chat 499')).toBeNull();
		expect(document.querySelectorAll('[data-sidebar-virtual-row]').length).toBeLessThan(40);
		expect(screen.getByText('Chat 0').closest('button')?.hasAttribute('draggable')).toBe(false);
	});

	it('renders mixed project header rows inside the virtual list', () => {
		render(SidebarChatListHost, {
			chats: Array.from({ length: 120 }, (_, index) =>
				makeChat(index, { projectPath: `/tmp/project-${index % 20}` }),
			),
			displayOptions: { groupByProject: true, compactChatItems: false },
		});

		expect(document.querySelector('[data-sidebar-virtual-list]')).toBeTruthy();
		expect(document.querySelector('[data-sidebar-project-header="/tmp/project-0"]')).toBeTruthy();
		expect(document.querySelectorAll('[data-sidebar-virtual-item="project-header"]').length).toBeGreaterThan(
			0,
		);
		expect(document.querySelectorAll('[data-sidebar-virtual-row]').length).toBeLessThan(40);
		expect(screen.queryByText('Chat 119')).toBeNull();
	});

	it('renders collapsed project groups as header-only virtual rows', () => {
		const chats = [
			makeChat(0, { projectPath: '/tmp/project-a' }),
			makeChat(1, { projectPath: '/tmp/project-a' }),
			makeChat(2, { projectPath: '/tmp/project-b' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: { groupByProject: true, compactChatItems: false },
			collapsedProjectKeys: new Set([sidebarProjectKey('/tmp/project-a')]),
		});

		const collapsedHeader = document.querySelector<HTMLElement>(
			'[data-sidebar-project-header="/tmp/project-a"]',
		);

		expect(collapsedHeader?.dataset.sidebarProjectCollapsed).toBe('true');
		expect(screen.queryByText('Chat 0')).toBeNull();
		expect(screen.queryByText('Chat 1')).toBeNull();
		expect(screen.getByText('Chat 2')).toBeTruthy();
	});

	it('collapses a grouped project when the list is shorter than the viewport', async () => {
		const chats = [
			makeChat(0, { projectPath: '/tmp/project-a' }),
			makeChat(1, { projectPath: '/tmp/project-a' }),
			makeChat(2, { projectPath: '/tmp/project-b' }),
		];

		render(SidebarChatListHost, {
			chats,
			displayOptions: { groupByProject: true, compactChatItems: false },
		});

		const header = document.querySelector<HTMLElement>(
			'[data-sidebar-project-header="/tmp/project-a"]',
		);
		if (!header) throw new Error('expected project header');

		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.getByText('Chat 1')).toBeTruthy();
		await fireEvent.click(header);
		await tick();

		expect(header.dataset.sidebarProjectCollapsed).toBe('true');
		expect(screen.queryByText('Chat 0')).toBeNull();
		expect(screen.queryByText('Chat 1')).toBeNull();
		expect(screen.getByText('Chat 2')).toBeTruthy();
	});

	it('toggles a project header collapse state', async () => {
		const onToggleProjectCollapsed = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: [makeProjectHeader('/tmp/project-a', 2, ['chat-0', 'chat-1'], true)],
			onToggleProjectCollapsed,
		});

		const header = document.querySelector<HTMLElement>(
			'[data-sidebar-project-header="/tmp/project-a"]',
		);
		if (!header) throw new Error('expected project header');

		expect(header.getAttribute('aria-expanded')).toBe('false');
		await fireEvent.click(header);

		expect(onToggleProjectCollapsed).toHaveBeenCalledWith(sidebarProjectKey('/tmp/project-a'));
	});

	it('uses compact chat row estimates in compact mode', () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			displayOptions: { groupByProject: false, compactChatItems: true },
		});

		const firstVirtualItem = document.querySelector<HTMLElement>('[data-sidebar-virtual-item="chat"]');

		expect(firstVirtualItem?.style.height).toBe('70px');
	});

	it('paints chat separators from the virtual list layer', () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			selectedChatId: 'chat-1',
			rowHeight,
		});

		const separator = document.querySelector<HTMLElement>('[data-sidebar-virtual-list-separator]');
		const selectedBackground = document.querySelector<HTMLElement>(
			'[data-sidebar-virtual-list-selected-background]',
		);
		const row = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
		const rowContent = row?.querySelector<HTMLElement>('[data-sidebar-virtual-row-content]');

		expect(separator).toBeTruthy();
		expect(separator?.className).toContain('bg-border');
		expect(separator?.className).toContain('z-10');
		expect(separator?.style.top).toBe('87px');
		expect(separator?.style.height).toBe('1px');
		expect(selectedBackground?.className).toContain('bg-sidebar-chat-item-selected-bg');
		expect(selectedBackground?.style.top).toBe(`${rowHeight - CHAT_ROW_SEPARATOR_SLOT_HEIGHT}px`);
		expect(selectedBackground?.style.height).toBe(`${rowHeight + CHAT_ROW_SEPARATOR_SLOT_HEIGHT}px`);
		expect(row?.className).toContain('bg-sidebar-chat-item-selected-bg');
		expect(rowContent?.className).toContain('bg-sidebar-chat-item-selected-bg');
		expect(rowContent?.className).not.toContain('bg-sidebar-chat-item-bg');
		expect(row?.className).not.toContain('border-b');
		expect(row?.className).not.toContain('border-border');
		expect(rowContent?.style.height).toBe(`calc(100% - ${CHAT_ROW_SEPARATOR_SLOT_HEIGHT}px)`);
	});

	it('updates visible rows when the shared viewport scrolls', async () => {
		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			rowHeight,
		});

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		viewport.scrollTop = rowHeight * 120;
		await fireEvent.scroll(viewport);
		await tick();

		expect(screen.getByText('Chat 120')).toBeTruthy();
		expect(screen.queryByText('Chat 0')).toBeNull();
	});

	it('scrolls an offscreen selected chat into view on recenter requests', async () => {
		const callbacks: Array<() => void> = [];

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			selectedChatId: 'chat-400',
			rowHeight,
			onRegisterRecenter: (callback: () => void) => callbacks.push(callback),
		});
		await tick();

		for (const callback of callbacks) callback();
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		expect(viewport.scrollTop).toBeGreaterThan(rowHeight * 350);
	});

	it('scrolls to a collapsed project header when the selected chat row is hidden', async () => {
		const callbacks: Array<() => void> = [];
		const rows: SidebarVirtualRow[] = [
			...makeRows(100),
			makeProjectHeader('/tmp/project-hidden', 1, ['hidden-chat'], true),
		];

		render(SidebarVirtualSortableChatListHost, {
			rows,
			selectedChatId: 'hidden-chat',
			rowHeight,
			onRegisterRecenter: (callback: () => void) => callbacks.push(callback),
		});
		await tick();

		for (const callback of callbacks) callback();
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		expect(viewport.scrollTop).toBeGreaterThan(rowHeight * 80);
	});

	it('does not scroll when the selected chat is already visible on recenter requests', async () => {
		const callbacks: Array<() => void> = [];

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			selectedChatId: 'chat-2',
			rowHeight,
			onRegisterRecenter: (callback: () => void) => callbacks.push(callback),
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		viewport.scrollTop = 0;
		for (const callback of callbacks) callback();
		await tick();

		expect(viewport.scrollTop).toBe(0);
	});

	it('persists adjacent reorder after a touch long press drag', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();

		expect(persist).toHaveBeenCalledWith({
			kind: 'relative',
			list: 'normal',
			chatId: 'chat-0',
			target: { chatIdAbove: 'chat-1' },
			visibleOrder: [
				'chat-1',
				'chat-0',
				...Array.from({ length: 18 }, (_, index) => `chat-${index + 2}`),
			],
			sequence: 1,
		});
	});

	it('does not persist touch drags across project scopes', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const rows = [makeScopedRow(0, '/tmp/project-a', ['chat-0']), makeScopedRow(1, '/tmp/project-b', ['chat-1'])];

		render(SidebarVirtualSortableChatListHost, {
			rows,
			isMobile: true,
			rowHeight,
			displayOptions: { groupByProject: true, compactChatItems: false },
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('does not reuse the last touch drop target over a mounted project header', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		const rows: SidebarVirtualRow[] = [
			makeScopedRow(0, '/tmp/project-a', ['chat-0', 'chat-1']),
			makeScopedRow(1, '/tmp/project-a', ['chat-0', 'chat-1']),
			makeProjectHeader('/tmp/project-b', 1),
			makeScopedRow(2, '/tmp/project-b', ['chat-2']),
		];

		render(SidebarVirtualSortableChatListHost, {
			rows,
			isMobile: true,
			rowHeight,
			displayOptions: { groupByProject: true, compactChatItems: false },
			onPersistReorder: persist,
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		const row0 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-0"]');
		const row1 = document.querySelector<HTMLElement>('[data-sidebar-virtual-row="chat-1"]');
		const header = document.querySelector<HTMLElement>('[data-sidebar-project-header="/tmp/project-b"]');
		if (!row0 || !row1 || !header) throw new Error('expected rows and project header');

		vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: 0, width: 320, height: 640 }),
		);
		vi.spyOn(row0, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: 0, width: 320, height: rowHeight }),
		);
		vi.spyOn(row1, 'getBoundingClientRect').mockReturnValue(
			rect({ left: 0, top: rowHeight, width: 320, height: rowHeight }),
		);
		vi.spyOn(document, 'elementFromPoint').mockImplementation((_, y) => {
			if (y >= rowHeight * 2 && y < rowHeight * 2 + PROJECT_HEADER_ROW_HEIGHT) return header;
			return y >= rowHeight ? row1 : row0;
		});

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, rowHeight * 2 + PROJECT_HEADER_ROW_HEIGHT / 2)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('does not persist when a touch drag returns to the original adjacent slot', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 100)],
			changedTouches: [touchAt(1, 20, 100)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 100)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('does not reuse the last touch drop target when dropping over the dragged row', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 150)],
			changedTouches: [touchAt(1, 20, 150)],
		});
		await tick();
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		await tick();
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 44)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('suppresses document text selection while a touch long press is pending', async () => {
		vi.useFakeTimers();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		expect(document.body.style.getPropertyValue('user-select')).toBe('none');
		expect(document.body.style.getPropertyValue('-webkit-user-select')).toBe('none');
		expect(document.body.style.getPropertyValue('-webkit-touch-callout')).toBe('none');
		expect(document.documentElement.style.getPropertyValue('user-select')).toBe('none');
		expect(row0.className).toContain('select-none');

		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 61)],
			changedTouches: [touchAt(1, 20, 61)],
		});
		await tick();

		expect(document.body.style.getPropertyValue('user-select')).toBe('');
		expect(document.body.style.getPropertyValue('-webkit-user-select')).toBe('');
		expect(document.body.style.getPropertyValue('-webkit-touch-callout')).toBe('');
		expect(document.documentElement.style.getPropertyValue('user-select')).toBe('');
	});

	it('clears existing text selection when a touch long press drag activates', async () => {
		vi.useFakeTimers();
		const selection = window.getSelection();
		if (!selection) throw new Error('expected selection API');
		const clearSelection = vi.spyOn(selection, 'removeAllRanges');

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		vi.advanceTimersByTime(370);
		await tick();

		expect(clearSelection).toHaveBeenCalled();
		await fireEvent.touchCancel(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 44)],
		});
	});

	it('allows normal scroll gestures before the touch long press threshold', async () => {
		vi.useFakeTimers();
		const persist = vi.fn();

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(20),
			isMobile: true,
			rowHeight,
			onPersistReorder: persist,
		});
		await tick();
		const { row0 } = installTouchGeometry();

		await fireEvent.touchStart(row0, {
			touches: [touchAt(1, 20, 44)],
			changedTouches: [touchAt(1, 20, 44)],
		});
		await fireEvent.touchMove(window, {
			touches: [touchAt(1, 20, 61)],
			changedTouches: [touchAt(1, 20, 61)],
		});
		vi.advanceTimersByTime(400);
		await fireEvent.touchEnd(window, {
			touches: [],
			changedTouches: [touchAt(1, 20, 61)],
		});
		await tick();

		expect(persist).not.toHaveBeenCalled();
	});

	it('uses virtual rendering for large normal chat lists', () => {
		render(SidebarChatListHost, {
			chats: Array.from({ length: 120 }, (_, index) => makeChat(index)),
		});

		expect(document.querySelector('[data-sidebar-virtual-list]')).toBeTruthy();
		expect(document.querySelectorAll('[data-sidebar-virtual-row]').length).toBeLessThan(40);
		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.queryByText('Chat 119')).toBeNull();
	});

	it('uses virtual rendering for filtered chat lists', () => {
		const chats = Array.from({ length: 160 }, (_, index) => makeChat(index));
		render(SidebarChatListHost, {
			chats,
			filteredChats: chats.slice(0, 120),
			searchFilter: 'Chat',
		});

		expect(document.querySelector('[data-sidebar-virtual-list]')).toBeTruthy();
		expect(
			document.querySelector('[data-sidebar-virtual-list]')?.getAttribute('data-sidebar-filtered'),
		).toBe('true');
		expect(document.querySelectorAll('[data-sidebar-virtual-row]').length).toBeLessThan(40);
		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.queryByText('Chat 119')).toBeNull();
	});

	it('uses virtual rendering for small normal chat lists', () => {
		render(SidebarChatListHost, {
			chats: Array.from({ length: 20 }, (_, index) => makeChat(index)),
		});

		expect(document.querySelector('[data-sidebar-virtual-list]')).toBeTruthy();
		expect(screen.getByText('Chat 0')).toBeTruthy();
	});
});
