import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SidebarSearchResults from '../SidebarSearchResults.svelte';
import { SEARCH_RESULT_ROW_HEIGHT } from '../sidebar-search-results';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatSearchResult } from '$shared/chat-search';
import * as m from '$lib/paraglide/messages.js';

const currentTime = new Date('2025-01-01T03:00:00.000Z');
const rowHeight = SEARCH_RESULT_ROW_HEIGHT;

function makeChat(index: number, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: `chat-${index}`,
		projectPath: '/tmp/project',
		effectiveProjectKey: '/tmp/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
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
		if (!(viewport instanceof HTMLElement))
			throw new Error('Expected search dialog results viewport');

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
		if (!(viewport instanceof HTMLElement))
			throw new Error('Expected search dialog results viewport');

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
		if (!(viewport instanceof HTMLElement))
			throw new Error('Expected search dialog results viewport');

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

	it('renders a transcript snippet for matching chats', () => {
		const transcriptMatch: ChatSearchResult = {
			chatId: 'chat-1',
			score: 1,
			matchedMessageCount: 1,
			snippets: [
				{
					messageOrdinal: 3,
					role: 'assistant',
					timestamp: '2025-01-01T00:00:00.000Z',
					text: 'Found the deployment token rotation detail',
				},
			],
		};

		render(SidebarSearchResults, {
			filteredChats: [makeChat(1)],
			transcriptMatchesByChatId: new Map([['chat-1', transcriptMatch]]),
			currentTime,
			highlightedIndex: 0,
			onSelectChat: vi.fn(),
			onHighlightChange: vi.fn(),
		});

		expect(screen.getByText('Assistant')).toBeTruthy();
		expect(screen.getByText('Found the deployment token rotation detail')).toBeTruthy();
	});

	it('shows transcript indexing status before rows are available', () => {
		render(SidebarSearchResults, {
			filteredChats: [],
			transcriptSearchIndexing: true,
			transcriptSearchIndex: { indexedChatCount: 1, pendingChatCount: 2 },
			currentTime,
			highlightedIndex: 0,
			onSelectChat: vi.fn(),
			onHighlightChange: vi.fn(),
		});

		expect(screen.getByRole('status').textContent).toContain(
			m.sidebar_search_transcript_indexing(),
		);
		expect(screen.getByText('No matching chats')).toBeTruthy();
	});

	it('renders a retryable inline transcript search error', async () => {
		const onRetryTranscriptSearch = vi.fn();
		render(SidebarSearchResults, {
			filteredChats: [],
			transcriptSearchError: m.sidebar_search_transcript_error(),
			currentTime,
			highlightedIndex: 0,
			onSelectChat: vi.fn(),
			onHighlightChange: vi.fn(),
			onRetryTranscriptSearch,
		});

		expect(screen.getByRole('alert').textContent).toContain(m.sidebar_search_transcript_error());
		await fireEvent.click(screen.getByRole('button', { name: m.common_retry() }));
		expect(onRetryTranscriptSearch).toHaveBeenCalledTimes(1);
	});
});
