import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatsApi from '$lib/api/chats';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import type { ChatListEntry } from '$shared/chat-list';
import SidebarHost from './SidebarHost.svelte';

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
		canReloadFromNativeHistory: false,
		tags: [],
		parentChat: null,
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
		chatSessions.upsertFromServer([
			makeServerChat('selected', false, '2026-02-01T00:00:00.000Z'),
			makeServerChat('manual-order-neighbor', false, '2026-03-01T00:00:00.000Z'),
			makeServerChat('recent-order-neighbor', false, '2026-01-01T00:00:00.000Z'),
			makeServerChat('archived', true, '2026-03-01T00:00:00.000Z'),
		]);
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

		archive.resolve({ success: true, chatId: 'selected', isArchived: true, isPinned: false, orderGroup: 'archived', changed: true });
		await waitFor(() => expect(listChats).toHaveBeenCalledOnce());
		expect(onChatSelect).toHaveBeenCalledOnce();
		expect(chatSessions.isArchiveMutationPending('selected')).toBe(false);
	});
});
