import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionsStore } from '../chat-sessions.svelte';
import type { ChatSession } from '$lib/types/session';

vi.mock('$lib/api/chats.js', () => ({
	listChats: vi.fn(),
	deleteChat: vi.fn(),
	setLastSelectedChat: vi.fn(),
	generateChatTitle: vi.fn(),
	reorderChat: vi.fn(),
	setChatTags: vi.fn(),
}));

vi.mock('$lib/api/settings.js', () => ({
	updateSessionName: vi.fn(),
}));

import {
	deleteChat,
	generateChatTitle,
	listChats,
	reorderChat,
	setChatTags,
	setLastSelectedChat,
} from '$lib/api/chats.js';
import { updateSessionName } from '$lib/api/settings.js';

const mockListChats = vi.mocked(listChats);
const mockDeleteChat = vi.mocked(deleteChat);
const mockSetLastSelectedChat = vi.mocked(setLastSelectedChat);
const mockGenerateChatTitle = vi.mocked(generateChatTitle);
const mockReorderChat = vi.mocked(reorderChat);
const mockSetChatTags = vi.mocked(setChatTags);
const mockUpdateSessionName = vi.mocked(updateSessionName);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeServerSession(overrides: Partial<ChatSession> = {}): ChatSession {
	return {
		id: 'chat-1',
		agentId: 'claude',
		model: 'sonnet',
		title: 'Chat 1',
		projectPath: '/repo',
		effectiveProjectKey: '/repo',
		orderGroup: 'normal',
		tags: [],
		permissionMode: 'default',
		thinkingMode: 'none',
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		...overrides,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? 'epoch-1',
	};
}

describe('ChatSessionsStore IO', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refreshChats fetches sessions and clears loading state', async () => {
		const store = new ChatSessionsStore();
		const sessions = [makeServerSession({ id: 'chat-1' })];
		mockListChats.mockResolvedValue({ sessions, total: 1, lastSelectedChatId: 'chat-1' });

		await store.refreshChats();

		expect(store.byId['chat-1']?.id).toBe('chat-1');
		expect(store.lastSelectedChatId).toBe('chat-1');
		expect(store.isLoadingChats).toBe(false);
	});

	it('quietRefreshChats does not enable loading state', async () => {
		const store = new ChatSessionsStore();
		store.isLoadingChats = false;
		mockListChats.mockResolvedValue({
			sessions: [makeServerSession({ id: 'chat-2', title: 'Quiet' })],
			total: 1,
			lastSelectedChatId: null,
		});

		await store.quietRefreshChats();

		expect(store.byId['chat-2']?.title).toBe('Quiet');
		expect(store.isLoadingChats).toBe(false);
	});

	it('runs a follow-up fetch when refresh is requested during an in-flight fetch', async () => {
		const store = new ChatSessionsStore();
		const first = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		const staleSessions = [makeServerSession({ id: 'stale', title: 'Stale' })];
		const freshSessions = [makeServerSession({ id: 'fresh', title: 'Fresh' })];
		mockListChats
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce({ sessions: freshSessions, total: 1, lastSelectedChatId: 'fresh' });

		const firstRefresh = store.quietRefreshChats();
		const secondRefresh = store.quietRefreshChats();
		first.resolve({ sessions: staleSessions, total: 1, lastSelectedChatId: 'stale' });
		await Promise.all([firstRefresh, secondRefresh]);

		expect(mockListChats).toHaveBeenCalledTimes(2);
		expect(store.byId['fresh']?.title).toBe('Fresh');
		expect(store.byId['stale']).toBeUndefined();
		expect(store.lastSelectedChatId).toBe('fresh');
	});

	it('notifies and refreshes when remote delete fails', async () => {
		const notifyError = vi.fn();
		const store = new ChatSessionsStore({ notifyError });
		mockDeleteChat.mockRejectedValue(new Error('delete failed'));
		mockListChats.mockResolvedValue({ sessions: [], total: 0, lastSelectedChatId: null });

		await store.deleteRemoteChat('chat-1');
		await Promise.resolve();

		expect(notifyError).toHaveBeenCalledWith('Failed to delete chat.');
		expect(mockListChats).toHaveBeenCalledTimes(1);
	});

	it('notifies when remote rename fails', async () => {
		const notifyError = vi.fn();
		const store = new ChatSessionsStore({ notifyError });
		mockUpdateSessionName.mockRejectedValue(new Error('rename failed'));

		const renamed = await store.renameChat('chat-1', 'New Title');

		expect(mockUpdateSessionName).toHaveBeenCalledWith('chat-1', 'New Title');
		expect(notifyError).toHaveBeenCalledWith('Failed to rename chat.');
		expect(renamed).toBe(false);
	});

	it('reports a successful remote rename', async () => {
		const store = new ChatSessionsStore();
		mockUpdateSessionName.mockResolvedValue({ success: true });

		const renamed = await store.renameChat('chat-1', 'New Title');

		expect(mockUpdateSessionName).toHaveBeenCalledWith('chat-1', 'New Title');
		expect(renamed).toBe(true);
	});

	it('moves a chat to a boundary and quietly refreshes changed order', async () => {
		const response = {
			success: true as const,
			chatId: 'chat-1',
			orderGroup: 'normal' as const,
			changed: true,
		};
		mockReorderChat.mockResolvedValue(response);
		mockListChats.mockResolvedValue({ sessions: [], total: 0, lastSelectedChatId: null });
		const store = new ChatSessionsStore();

		await expect(store.moveChatToBoundary('chat-1', 'top')).resolves.toEqual(response);

		expect(mockReorderChat).toHaveBeenCalledWith({
			chatId: 'chat-1',
			placement: { kind: 'boundary', boundary: 'top' },
		});
		expect(mockListChats).toHaveBeenCalledTimes(1);
	});

	it('quietly refreshes an unchanged boundary result', async () => {
		mockReorderChat.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			orderGroup: 'archived',
			changed: false,
		});
		mockListChats.mockResolvedValue({ sessions: [], total: 0, lastSelectedChatId: null });
		const store = new ChatSessionsStore();

		await store.moveChatToBoundary('chat-1', 'bottom');

		expect(mockReorderChat).toHaveBeenCalledWith({
			chatId: 'chat-1',
			placement: { kind: 'boundary', boundary: 'bottom' },
		});
		expect(mockListChats).toHaveBeenCalledTimes(1);
	});

	it('notifies and skips refresh when boundary mutation fails', async () => {
		const notifyError = vi.fn();
		mockReorderChat.mockRejectedValue(new Error('reorder failed'));
		const store = new ChatSessionsStore({ notifyError });

		await expect(store.moveChatToBoundary('chat-1', 'top')).resolves.toBeNull();

		expect(notifyError).toHaveBeenCalledWith('Failed to reorder chats.');
		expect(mockListChats).not.toHaveBeenCalled();
	});

	it('preserves mutation success when the quiet refresh fails', async () => {
		const notifyError = vi.fn();
		const response = {
			success: true as const,
			chatId: 'chat-1',
			orderGroup: 'pinned' as const,
			changed: true,
		};
		mockReorderChat.mockResolvedValue(response);
		mockListChats.mockRejectedValue(new Error('refresh failed'));
		const store = new ChatSessionsStore({ notifyError });

		await expect(store.moveChatToBoundary('chat-1', 'bottom')).resolves.toEqual(response);

		expect(notifyError).toHaveBeenCalledWith('Failed to refresh chats.');
	});

	it('persists tags and patches the server response into the chat record', async () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['existing'] })]);
		mockSetChatTags.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			tags: ['existing', 'urgent'],
		});
		mockListChats.mockResolvedValue({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['existing', 'urgent'] })],
			total: 1,
			lastSelectedChatId: 'chat-1',
		});

		await expect(store.setChatTags('chat-1', ['existing', 'urgent'])).resolves.toBe(true);

		expect(mockSetChatTags).toHaveBeenCalledWith('chat-1', ['existing', 'urgent']);
		expect(mockListChats).toHaveBeenCalledTimes(1);
		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);
	});

	it('runs a follow-up refresh when an older chat-list fetch overlaps a tag mutation', async () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['existing'] })]);
		const staleFetch = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		mockListChats.mockReturnValueOnce(staleFetch.promise).mockResolvedValueOnce({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['existing', 'urgent'] })],
			total: 1,
			lastSelectedChatId: 'chat-1',
		});
		mockSetChatTags.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			tags: ['existing', 'urgent'],
		});

		const initialRefresh = store.quietRefreshChats();
		const mutation = store.setChatTags('chat-1', ['existing', 'urgent']);
		await Promise.resolve();
		staleFetch.resolve({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['existing'] })],
			total: 1,
			lastSelectedChatId: 'chat-1',
		});

		await expect(Promise.all([initialRefresh, mutation])).resolves.toEqual([undefined, true]);
		expect(mockListChats).toHaveBeenCalledTimes(2);
		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);
	});

	it('preserves a successful tag mutation when its convergence refresh fails', async () => {
		const notifyError = vi.fn();
		const store = new ChatSessionsStore({ notifyError });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['existing'] })]);
		mockSetChatTags.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			tags: ['existing', 'urgent'],
		});
		mockListChats.mockRejectedValue(new Error('refresh failed'));

		await expect(store.setChatTags('chat-1', ['existing', 'urgent'])).resolves.toBe(true);

		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);
		expect(notifyError).toHaveBeenCalledWith('Failed to refresh chats.');
	});

	it('reports a failed persisted tag mutation without changing local tags', async () => {
		const notifyError = vi.fn();
		const store = new ChatSessionsStore({ notifyError });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['existing'] })]);
		mockSetChatTags.mockRejectedValue(new Error('tag update failed'));

		await expect(store.setChatTags('chat-1', ['urgent'])).resolves.toBe(false);

		expect(notifyError).toHaveBeenCalledWith('Failed to update chat tags.');
		expect(store.byId['chat-1'].tags).toEqual(['existing']);
	});

	it('generates a chat title from a message and patches local state', async () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ id: 'chat-1', title: 'Old Title' })]);
		mockGenerateChatTitle.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			title: 'Generated Title',
		});

		await store.generateChatTitleFromMessage('chat-1', 'source message', 8);

		expect(mockGenerateChatTitle).toHaveBeenCalledWith({
			chatId: 'chat-1',
			message: 'source message',
			messageSeq: 8,
		});
		expect(store.byId['chat-1']?.title).toBe('Generated Title');
	});

	it('notifies when chat title generation fails', async () => {
		const notifyError = vi.fn();
		const store = new ChatSessionsStore({ notifyError });
		mockGenerateChatTitle.mockRejectedValue(new Error('title failed'));

		await store.generateChatTitleFromMessage('chat-1', 'source message');

		expect(mockGenerateChatTitle).toHaveBeenCalledWith({
			chatId: 'chat-1',
			message: 'source message',
		});
		expect(notifyError).toHaveBeenCalledWith('Failed to generate chat title.');
	});

	it('remembers selected chats through the server helper', async () => {
		const store = new ChatSessionsStore();
		mockSetLastSelectedChat.mockResolvedValue({ success: true, lastSelectedChatId: 'chat-1' });

		store.rememberSelectedChat('chat-1');
		await Promise.resolve();
		await Promise.resolve();

		expect(mockSetLastSelectedChat).toHaveBeenCalledWith('chat-1');
		expect(store.lastSelectedChatId).toBe('chat-1');
	});

	it('coalesces remembered selection writes while a write is in flight', async () => {
		const first = deferred<{ success: true; lastSelectedChatId: string | null }>();
		const second = deferred<{ success: true; lastSelectedChatId: string | null }>();
		const setLastSelected = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const store = new ChatSessionsStore({ setLastSelectedChat: setLastSelected });

		store.rememberSelectedChat('chat-a');
		store.rememberSelectedChat('chat-b');
		store.rememberSelectedChat('chat-c');
		expect(setLastSelected).toHaveBeenCalledTimes(1);
		expect(setLastSelected).toHaveBeenCalledWith('chat-a');

		first.resolve({ success: true, lastSelectedChatId: 'chat-a' });
		await first.promise;
		await Promise.resolve();
		await Promise.resolve();

		expect(setLastSelected).toHaveBeenCalledTimes(2);
		expect(setLastSelected).toHaveBeenLastCalledWith('chat-c');
		second.resolve({ success: true, lastSelectedChatId: 'chat-c' });
		await second.promise;
		await Promise.resolve();

		expect(store.lastSelectedChatId).toBe('chat-c');
	});
});
