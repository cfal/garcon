import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';

import SidebarChatListHost from './SidebarChatListHost.svelte';
import SidebarVirtualSortableChatListHost from './SidebarVirtualSortableChatListHost.svelte';
import type { SidebarVirtualChatRow } from '../sidebar-virtual-chat-list';
import type { ChatSessionRecord } from '$lib/types/chat-session';

const rowHeight = 88;

function makeChat(index: number, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: `chat-${index}`,
		projectPath: '/tmp/project',
		title: `Chat ${index}`,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'think',
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
	return Array.from({ length: count }, (_, index) => {
		const chat = makeChat(index);
		return {
			type: 'chat' as const,
			key: `normal:${chat.id}`,
			chat,
			list: 'normal' as const,
			isPinned: false,
			isArchived: false,
		};
	});
}

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
			onRegisterRecenter: (callback) => callbacks.push(callback),
		});
		await tick();

		for (const callback of callbacks) callback();
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		expect(viewport.scrollTop).toBeGreaterThan(rowHeight * 350);
	});

	it('does not scroll when the selected chat is already visible on recenter requests', async () => {
		const callbacks: Array<() => void> = [];

		render(SidebarVirtualSortableChatListHost, {
			rows: makeRows(500),
			selectedChatId: 'chat-2',
			rowHeight,
			onRegisterRecenter: (callback) => callbacks.push(callback),
		});
		await tick();

		const viewport = screen.getByTestId('virtual-sidebar-viewport');
		viewport.scrollTop = 0;
		for (const callback of callbacks) callback();
		await tick();

		expect(viewport.scrollTop).toBe(0);
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
		expect(document.querySelector('[data-sidebar-virtual-list]')?.getAttribute('data-sidebar-filtered')).toBe('true');
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
