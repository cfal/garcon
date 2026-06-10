import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SidebarSearchResults from '../SidebarSearchResults.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

const currentTime = new Date('2025-01-01T03:00:00.000Z');
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

function makeChats(count: number): ChatSessionRecord[] {
	return Array.from({ length: count }, (_, index) => makeChat(index));
}

describe('SidebarSearchResults', () => {
	afterEach(cleanup);

	it('renders a bounded visible slice for large dialog result sets', () => {
		render(SidebarSearchResults, {
			filteredChats: makeChats(500),
			currentTime,
			highlightedIndex: 0,
			onSelectChat: vi.fn(),
			onHighlightChange: vi.fn(),
		});

		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.queryByText('Chat 499')).toBeNull();
		expect(document.querySelectorAll('[data-search-dialog-virtual-row]').length).toBeLessThan(40);
	});

	it('updates visible dialog results when the results viewport scrolls', async () => {
		render(SidebarSearchResults, {
			filteredChats: makeChats(500),
			currentTime,
			highlightedIndex: 0,
			onSelectChat: vi.fn(),
			onHighlightChange: vi.fn(),
		});

		const viewport = document.querySelector('[data-slot="search-dialog-results"]');
		if (!(viewport instanceof HTMLElement)) throw new Error('Expected search dialog results viewport');

		viewport.scrollTop = rowHeight * 120;
		await fireEvent.scroll(viewport);
		await tick();

		expect(screen.getByText('Chat 120')).toBeTruthy();
		expect(screen.queryByText('Chat 0')).toBeNull();
	});

	it('scrolls a deep highlighted result into view when mounted', async () => {
		render(SidebarSearchResults, {
			filteredChats: makeChats(500),
			currentTime,
			highlightedIndex: 400,
			onSelectChat: vi.fn(),
			onHighlightChange: vi.fn(),
		});

		const viewport = document.querySelector('[data-slot="search-dialog-results"]');
		if (!(viewport instanceof HTMLElement)) throw new Error('Expected search dialog results viewport');

		await waitFor(() => {
			expect(viewport.scrollTop).toBeGreaterThan(rowHeight * 350);
		});
		expect(screen.getByText('Chat 400')).toBeTruthy();
	});

	it('scrolls back to the first result after the highlighted index resets', async () => {
		const handlers = {
			onSelectChat: vi.fn(),
			onHighlightChange: vi.fn(),
		};
		const view = render(SidebarSearchResults, {
			filteredChats: makeChats(500),
			currentTime,
			highlightedIndex: 300,
			...handlers,
		});

		const viewport = document.querySelector('[data-slot="search-dialog-results"]');
		if (!(viewport instanceof HTMLElement)) throw new Error('Expected search dialog results viewport');

		await waitFor(() => {
			expect(viewport.scrollTop).toBeGreaterThan(rowHeight * 250);
		});

		await view.rerender({
			filteredChats: makeChats(500),
			currentTime,
			highlightedIndex: 0,
			...handlers,
		});

		await waitFor(() => {
			expect(viewport.scrollTop).toBe(0);
		});
		expect(screen.getByText('Chat 0')).toBeTruthy();
	});

	it('keeps small result sets on the full-render path', () => {
		render(SidebarSearchResults, {
			filteredChats: makeChats(20),
			currentTime,
			highlightedIndex: 0,
			onSelectChat: vi.fn(),
			onHighlightChange: vi.fn(),
		});

		expect(document.querySelector('[data-search-dialog-virtual-list]')).toBeNull();
		expect(screen.getByText('Chat 0')).toBeTruthy();
		expect(screen.getByText('Chat 19')).toBeTruthy();
	});
});
