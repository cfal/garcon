import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SidebarSearchResults from '../SidebarSearchResults.svelte';
import SidebarSearchDialogHost from './SidebarSearchDialogHost.svelte';
import { SEARCH_RESULT_ROW_HEIGHT } from '../sidebar-search-results';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatSearchResult } from '$shared/chat-search';

const currentTime = new Date('2025-01-01T03:00:00.000Z');
const rowHeight = SEARCH_RESULT_ROW_HEIGHT;

class TestIntersectionObserver {
	static instances: TestIntersectionObserver[] = [];
	private lastIntersection: boolean | null = null;
	readonly observe = vi.fn(() => {
		if (this.lastIntersection === null) return;
		queueMicrotask(() => this.deliver(this.lastIntersection ?? false));
	});
	readonly unobserve = vi.fn();
	readonly disconnect = vi.fn();

	constructor(private readonly callback: IntersectionObserverCallback) {
		TestIntersectionObserver.instances.push(this);
	}

	trigger(isIntersecting: boolean): void {
		this.lastIntersection = isIntersecting;
		this.deliver(isIntersecting);
	}

	private deliver(isIntersecting: boolean): void {
		this.callback([{ isIntersecting } as IntersectionObserverEntry], this as never);
	}
}

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
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'draft',
		lastMessage: `Chat ${index} preview`,
		tags: [],
		firstMessage: `Chat ${index} first`,
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? null,
	};
}

function makeChats(count: number): ChatSessionRecord[] {
	return Array.from({ length: count }, (_, index) => makeChat(index));
}

describe('SidebarSearchResults', () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		TestIntersectionObserver.instances = [];
	});

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
		const virtualRows = document.querySelectorAll('[data-search-dialog-virtual-row]');
		expect(virtualRows.length).toBeLessThan(40);
		expect(document.querySelectorAll('[data-search-dialog-row-separator]')).toHaveLength(
			virtualRows.length,
		);
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
			highlightRevealVersion: 1,
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
		const firstRow = screen.getAllByRole('option')[0];
		expect(firstRow?.classList.contains('py-1.5')).toBe(true);
		expect(firstRow?.style.minHeight).toBe(`${rowHeight}px`);
		expect(firstRow?.parentElement?.classList.contains('divide-y')).toBe(true);
	});

	it('renders a transcript snippet for matching chats', () => {
		const transcriptMatch: ChatSearchResult = {
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			score: 1,
			matchedMessageCount: 1,
			snippets: [
				{
					ordinal: 3,
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

	it('loads from the near-tail sentinel and ignores observer delivery while busy', async () => {
		vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
		const load = Promise.withResolvers<void>();
		const onLoadMoreTranscriptResults = vi.fn(() => load.promise);
		const handlers = { onSelectChat: vi.fn(), onHighlightChange: vi.fn() };
		const view = render(SidebarSearchResults, {
			filteredChats: makeChats(50),
			currentTime,
			highlightedIndex: 0,
			showTranscriptPagination: true,
			hasMoreTranscriptResults: true,
			onLoadMoreTranscriptResults,
			...handlers,
		});
		await tick();
		const observer = TestIntersectionObserver.instances.at(-1);
		if (!observer) throw new Error('Expected results sentinel observer');

		observer.trigger(true);
		expect(onLoadMoreTranscriptResults).toHaveBeenCalledTimes(1);
		await view.rerender({
			filteredChats: makeChats(50),
			currentTime,
			highlightedIndex: 0,
			showTranscriptPagination: true,
			hasMoreTranscriptResults: true,
			loadingMoreTranscriptResults: true,
			onLoadMoreTranscriptResults,
			...handlers,
		});
		TestIntersectionObserver.instances.at(-1)?.trigger(true);
		expect(onLoadMoreTranscriptResults).toHaveBeenCalledTimes(1);
		load.resolve();
	});

	it('continues automatic loading after a footer retry while the sentinel remains visible', async () => {
		vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
		const retry = Promise.withResolvers<void>();
		const nextPage = Promise.withResolvers<void>();
		const onLoadMoreTranscriptResults = vi
			.fn<() => Promise<void>>()
			.mockReturnValueOnce(retry.promise)
			.mockReturnValueOnce(nextPage.promise);
		const handlers = { onSelectChat: vi.fn(), onHighlightChange: vi.fn() };
		const view = render(SidebarSearchResults, {
			filteredChats: makeChats(50),
			currentTime,
			highlightedIndex: 0,
			showTranscriptPagination: true,
			hasMoreTranscriptResults: true,
			transcriptSearchPageError: 'failed',
			onLoadMoreTranscriptResults,
			...handlers,
		});
		await tick();
		const observer = TestIntersectionObserver.instances.at(-1);
		if (!observer) throw new Error('Expected results sentinel observer');
		observer.trigger(true);
		expect(onLoadMoreTranscriptResults).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Retry loading more results' }));
		expect(onLoadMoreTranscriptResults).toHaveBeenCalledTimes(1);
		await view.rerender({
			filteredChats: makeChats(50),
			currentTime,
			highlightedIndex: 0,
			showTranscriptPagination: true,
			hasMoreTranscriptResults: true,
			loadingMoreTranscriptResults: true,
			transcriptSearchPageError: null,
			onLoadMoreTranscriptResults,
			...handlers,
		});
		retry.resolve();
		await view.rerender({
			filteredChats: makeChats(50),
			currentTime,
			highlightedIndex: 0,
			showTranscriptPagination: true,
			hasMoreTranscriptResults: true,
			loadingMoreTranscriptResults: false,
			transcriptSearchPageError: null,
			onLoadMoreTranscriptResults,
			...handlers,
		});

		await waitFor(() => expect(onLoadMoreTranscriptResults).toHaveBeenCalledTimes(2));
	});

	it('keeps one footer control through load, retry, update, terminal, and cap states', async () => {
		const onLoadMoreTranscriptResults = vi.fn(async () => undefined);
		const onRetryTranscriptSearchRevalidation = vi.fn(async () => undefined);
		const handlers = { onSelectChat: vi.fn(), onHighlightChange: vi.fn() };
		const base = {
			filteredChats: makeChats(3),
			currentTime,
			highlightedIndex: 0,
			showTranscriptPagination: true,
			hasMoreTranscriptResults: false,
			loadingMoreTranscriptResults: false,
			transcriptSearchPageError: null,
			transcriptSearchRevalidating: false,
			transcriptSearchRevalidationError: null,
			transcriptSearchLimitReached: false,
			onLoadMoreTranscriptResults,
			onRetryTranscriptSearchRevalidation,
			...handlers,
		};
		const view = render(SidebarSearchResults, { ...base, hasMoreTranscriptResults: true });
		const footer = screen.getByRole('button', { name: 'Load more' });
		footer.focus();
		await fireEvent.click(footer);
		expect(onLoadMoreTranscriptResults).toHaveBeenCalledTimes(1);

		await view.rerender({ ...base, loadingMoreTranscriptResults: true });
		expect(screen.getByRole('button', { name: 'Loading more results…' })).toBe(footer);
		expect(footer.getAttribute('aria-disabled')).toBe('true');
		expect(document.activeElement).toBe(footer);
		expect(document.querySelector('[data-slot="search-dialog-results"]')?.getAttribute('aria-busy'))
			.toBe('true');

		await view.rerender({ ...base, transcriptSearchPageError: 'failed' });
		expect(screen.getByRole('button', { name: 'Retry loading more results' })).toBe(footer);
		await view.rerender({ ...base, transcriptSearchRevalidating: true });
		expect(screen.getByRole('button', { name: 'Updating results…' })).toBe(footer);
		await view.rerender({ ...base, transcriptSearchRevalidationError: 'failed' });
		expect(screen.getByRole('button', { name: 'Retry updating results' })).toBe(footer);
		await fireEvent.click(footer);
		expect(onRetryTranscriptSearchRevalidation).toHaveBeenCalledTimes(1);
		await view.rerender({ ...base });
		expect(screen.getByRole('button', { name: 'All transcript matches loaded' })).toBe(footer);
		await view.rerender({ ...base, transcriptSearchLimitReached: true });
		expect(screen.getByRole('button', { name: /first 500 transcript matches/ })).toBe(footer);
		expect(document.activeElement).toBe(footer);
	});

	it('preserves the visible row anchor across an atomic result reorder', async () => {
		const handlers = { onSelectChat: vi.fn(), onHighlightChange: vi.fn() };
		const initialChats = makeChats(20);
		const view = render(SidebarSearchResults, {
			filteredChats: initialChats,
			currentTime,
			highlightedIndex: 0,
			...handlers,
		});
		const viewport = document.querySelector('[data-slot="search-dialog-results"]');
		if (!(viewport instanceof HTMLElement)) throw new Error('Expected search results viewport');
		await tick();
		await tick();
		viewport.scrollTop = rowHeight * 7 + 9;

		await view.rerender({
			filteredChats: [initialChats[7]!, ...initialChats.filter((_, index) => index !== 7)],
			currentTime,
			highlightedIndex: 0,
			revalidationVersion: 1,
			...handlers,
		});
		await tick();

		expect(viewport.scrollTop).toBe(9);
	});

	it('resets scroll only when the explicit result-reset version changes', async () => {
		const handlers = { onSelectChat: vi.fn(), onHighlightChange: vi.fn() };
		const chats = makeChats(20);
		const view = render(SidebarSearchResults, {
			filteredChats: chats,
			currentTime,
			highlightedIndex: 0,
			...handlers,
		});
		const viewport = document.querySelector('[data-slot="search-dialog-results"]');
		if (!(viewport instanceof HTMLElement)) throw new Error('Expected search results viewport');
		await tick();
		await tick();
		viewport.scrollTop = 120;

		await view.rerender({
			filteredChats: [...chats, makeChat(20)],
			currentTime,
			highlightedIndex: 0,
			...handlers,
		});
		expect(viewport.scrollTop).toBe(120);
		await view.rerender({
			filteredChats: chats,
			currentTime,
			highlightedIndex: 0,
			resultsResetVersion: 1,
			...handlers,
		});
		await waitFor(() => expect(viewport.scrollTop).toBe(0));
	});

	it('preserves scroll when an append enables virtualization', async () => {
		const view = render(SidebarSearchDialogHost, {
			filteredChats: makeChats(70),
			currentTime,
		});
		const viewport = document.querySelector('[data-slot="search-dialog-results"]');
		if (!(viewport instanceof HTMLElement)) throw new Error('Expected search results viewport');
		await tick();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		viewport.scrollTop = rowHeight * 60;
		await fireEvent.scroll(viewport);

		await view.rerender({
			filteredChats: makeChats(120),
			currentTime,
		});
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		expect(viewport.scrollTop).toBe(rowHeight * 60);
	});

	it('keeps the polite announcement mounted and omits paging controls when unsupported', async () => {
		const handlers = { onSelectChat: vi.fn(), onHighlightChange: vi.fn() };
		const view = render(SidebarSearchResults, {
			filteredChats: makeChats(2),
			currentTime,
			highlightedIndex: 0,
			transcriptSearchAnnouncement: '',
			...handlers,
		});
		const status = screen.getByRole('status');
		const initialAnnouncement = status.firstElementChild;
		expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
		await view.rerender({
			filteredChats: makeChats(2),
			currentTime,
			highlightedIndex: 0,
			transcriptSearchAnnouncement: 'More transcript matches loaded, 2 chats shown',
			transcriptSearchAnnouncementVersion: 1,
			...handlers,
		});
		expect(screen.getByRole('status')).toBe(status);
		const firstAnnouncement = status.firstElementChild;
		expect(firstAnnouncement).not.toBe(initialAnnouncement);
		expect(status.textContent).toContain('2 chats shown');

		await view.rerender({
			filteredChats: makeChats(2),
			currentTime,
			highlightedIndex: 0,
			transcriptSearchAnnouncement: 'More transcript matches loaded, 2 chats shown',
			transcriptSearchAnnouncementVersion: 2,
			...handlers,
		});
		expect(screen.getByRole('status')).toBe(status);
		expect(status.firstElementChild).not.toBe(firstAnnouncement);
		expect(status.textContent).toContain('2 chats shown');
	});

});
