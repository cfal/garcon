import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatsApi from '$lib/api/chats';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import type { ChatListEntry } from '$shared/chat-list';
import SidebarHost from './SidebarHost.svelte';
import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte';

vi.mock('$lib/api/chats', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/chats')>('$lib/api/chats');
	return { ...actual, setChatArchived: vi.fn() };
});

function makeServerChat(
	id: string,
	archived = false,
	lastActivityAt: string | null = null,
): ChatListEntry {
	return {
		id,
		projectPath: '/workspace/repo',
		orderGroup: archived ? 'archived' : 'normal',
		title: id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		activity: { createdAt: null, lastActivityAt, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: archived,
		isActive: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		activityStatus: null,
		observation: null, canReloadFromNativeHistory: false,
		tags: [],
		parentChatId: null,
		lineage: null,
		agentOwnershipEpoch: 'epoch-1',
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	cleanup();
});

describe('sidebar bulk archive flow', () => {
	it('navigates to a context parent without including it in a filtered bulk archive', async () => {
		const entries = [
			makeServerChat('parent'),
			{
				...makeServerChat('child'),
				parentChatId: 'parent',
				lineage: null,
			},
		];
		const chatSessions = new ChatSessionsStore({
			setChatArchived: chatsApi.setChatArchived,
			listChats: async () => ({ sessions: entries, total: 2, lastSelectedChatId: 'parent' }),
		});
		await chatSessions.refreshChats();
		vi.mocked(chatsApi.setChatArchived).mockResolvedValue({
			success: true,
			chatId: 'child',
			isArchived: true,
			isPinned: false,
			orderGroup: 'archived',
			changed: true,
		});
		const sidebarSearch = createSidebarSearchStore({
			getTranscriptSearchEnabled: () => false,
			getSearchResultSort: () => 'relevance',
			getChats: () => chatSessions.orderedChats,
			getSelectedChatId: () => 'child',
			notifyError: vi.fn(),
		});
		sidebarSearch.activeQuery = 'child';
		const onChatSelect = vi.fn();
		const onNewChat = vi.fn();
		const { container } = render(SidebarHost, {
			chatSessions,
			sidebarSearch,
			selectedChatId: 'child',
			autoLoadSavedSearches: false,
			sidebarNestDelegatedChats: true,
			sidebarGroupingFields: [],
			onChatSelect,
			onNewChat,
		});
		const child = container.querySelector<HTMLElement>('[data-sidebar-virtual-row="child"]')!;
		await fireEvent.click(within(child).getByRole('button', { name: 'Chat actions' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
		await waitFor(() => expect(onChatSelect).toHaveBeenCalledWith('parent'));
		expect(onNewChat).not.toHaveBeenCalled();
		expect(chatsApi.setChatArchived).toHaveBeenCalledExactlyOnceWith({
			chatId: 'child',
			isArchived: true,
		});
	});

	it('moves selected chats ahead of archived rows before the requests complete', async () => {
		const archive = deferred<Awaited<ReturnType<typeof chatsApi.setChatArchived>>>();
		vi.mocked(chatsApi.setChatArchived).mockReturnValueOnce(archive.promise);
		const listChats = vi.fn(async () => ({
			sessions: [
				makeServerChat('recent-order-neighbor', false, '2026-01-01T00:00:00.000Z'),
				makeServerChat('selected', true, '2026-02-01T00:00:00.000Z'),
				makeServerChat('manual-order-neighbor', false, '2026-03-01T00:00:00.000Z'),
				makeServerChat('archived', true, '2026-03-01T00:00:00.000Z'),
			],
			total: 4,
			lastSelectedChatId: 'recent-order-neighbor',
		}));
		const chatSessions = new ChatSessionsStore({
			setChatArchived: chatsApi.setChatArchived,
			listChats,
		});
		const initialEntries = [
			makeServerChat('selected', false, '2026-02-01T00:00:00.000Z'),
			makeServerChat('manual-order-neighbor', false, '2026-03-01T00:00:00.000Z'),
			makeServerChat('recent-order-neighbor', false, '2026-01-01T00:00:00.000Z'),
			makeServerChat('archived', true, '2026-03-01T00:00:00.000Z'),
		];
		listChats.mockResolvedValueOnce({
			sessions: initialEntries,
			total: initialEntries.length,
			lastSelectedChatId: 'selected',
		});
		await chatSessions.refreshChats();
		listChats.mockClear();
		const onChatSelect = vi.fn();
		const { container } = render(SidebarHost, {
			chatSessions,
			selectedChatId: 'selected',
			autoLoadSavedSearches: false,
			sidebarSortMode: 'recent',
			onChatSelect,
		});

		const selectedRow = container.querySelector<HTMLElement>(
			'[data-sidebar-virtual-row="selected"]',
		);
		if (!selectedRow) throw new Error('Selected chat row was not rendered.');
		await fireEvent.click(within(selectedRow).getByRole('button', { name: 'Chat actions' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Select' }));
		await fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));

		expect(chatsApi.setChatArchived).toHaveBeenCalledWith({ chatId: 'selected', isArchived: true });
		expect(onChatSelect).toHaveBeenCalledOnce();
		expect(onChatSelect).toHaveBeenCalledWith('recent-order-neighbor');
		expect(
			Array.from(container.querySelectorAll('[data-sidebar-virtual-list-row="archived"]')).map(
				(row) => row.getAttribute('data-sidebar-virtual-row'),
			),
		).toEqual(['selected', 'archived']);

		expect(screen.getByRole('button', { name: 'Unarchive' }).hasAttribute('disabled')).toBe(true);
		expect(chatsApi.setChatArchived).toHaveBeenCalledOnce();

		archive.resolve({
			success: true,
			chatId: 'selected',
			isArchived: true,
			isPinned: false,
			orderGroup: 'archived',
			changed: true,
		});
		await waitFor(() => expect(listChats).toHaveBeenCalledOnce());
		expect(onChatSelect).toHaveBeenCalledOnce();
		expect(chatSessions.isArchiveMutationPending('selected')).toBe(false);
	});
});
