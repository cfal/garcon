import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionsStore } from '../chat-sessions.svelte';
import type { ChatSession } from '$lib/types/session';
import { ApiError, ApiMutationOutcomeUnknownError } from '$lib/api/client';
import { ChatTagMutationBlockedError } from '../chat-tag-mutation-result.js';

vi.mock('$lib/api/chats.js', async (importOriginal) => ({
	...await importOriginal<typeof import('$lib/api/chats.js')>(),
	listChats: vi.fn(),
	deleteChat: vi.fn(),
	setLastSelectedChat: vi.fn(),
	generateChatTitle: vi.fn(),
	reorderChat: vi.fn(),
	replaceChatTags: vi.fn(),
	applyChatTagDelta: vi.fn(),
	transitionChatTags: vi.fn(),
	recoverChatTags: vi.fn(),
	toggleArchive: vi.fn(),
}));

vi.mock('$lib/api/settings.js', () => ({
	updateSessionName: vi.fn(),
}));

import {
	deleteChat,
	generateChatTitle,
	listChats,
	reorderChat,
	replaceChatTags,
	setLastSelectedChat,
	toggleArchive,
} from '$lib/api/chats.js';
import { updateSessionName } from '$lib/api/settings.js';

const mockListChats = vi.mocked(listChats);
const mockDeleteChat = vi.mocked(deleteChat);
const mockSetLastSelectedChat = vi.mocked(setLastSelectedChat);
const mockGenerateChatTitle = vi.mocked(generateChatTitle);
const mockReorderChat = vi.mocked(reorderChat);
const mockReplaceChatTags = vi.mocked(replaceChatTags);
const mockToggleArchive = vi.mocked(toggleArchive);
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

async function flushMicrotasks(): Promise<void> {
	for (let remaining = 20; remaining > 0; remaining -= 1) {
		await Promise.resolve();
	}
}

function makeServerSession(overrides: Partial<ChatSession> = {}): ChatSession {
	return {
		id: 'chat-1',
		agentId: 'claude',
		model: 'sonnet',
		title: 'Chat 1',
		projectPath: '/repo',
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
		canReloadFromNativeHistory: false,
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		...overrides,
		parentChat: overrides.parentChat ?? null,
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

	it('does not let an older list response overwrite a newer project binding', async () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ projectPath: '/workspace/a' })]);
		const stale = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		mockListChats.mockReturnValueOnce(stale.promise);

		const refresh = store.quietRefreshChats();
		store.patchChat('chat-1', { projectPath: '/workspace/b' });
		stale.resolve({
			sessions: [makeServerSession({ projectPath: '/workspace/a' })],
			total: 1,
			lastSelectedChatId: 'chat-1',
		});
		await refresh;

		expect(store.byId['chat-1']?.projectPath).toBe('/workspace/b');
	});

	it('fences an older list response across an observed A/B/A binding sequence', async () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ projectPath: '/workspace/a' })]);
		const stale = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		mockListChats.mockReturnValueOnce(stale.promise);

		const refresh = store.quietRefreshChats();
		store.patchChat('chat-1', { projectPath: '/workspace/b' });
		store.patchChat('chat-1', { projectPath: '/workspace/a' });
		stale.resolve({
			sessions: [makeServerSession({ projectPath: '/workspace/b' })],
			total: 1,
			lastSelectedChatId: 'chat-1',
		});
		await refresh;

		expect(store.byId['chat-1']?.projectPath).toBe('/workspace/a');
	});

	it('projects an archive at the front of the archived list until refresh reconciles it', async () => {
		const archive = deferred<{ success: boolean; isArchived: boolean }>();
		const refresh = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		mockToggleArchive.mockReturnValue(archive.promise);
		mockListChats.mockReturnValue(refresh.promise);
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'target', isPinned: true, orderGroup: 'pinned' }),
			makeServerSession({ id: 'normal' }),
			makeServerSession({ id: 'archived', isArchived: true, orderGroup: 'archived' }),
		]);

		const mutation = store.startArchivingChats(['target']);

		expect(mutation.chatIds).toEqual(['target']);
		expect(store.isArchiveMutationPending('target')).toBe(true);
		expect(store.byId.target).toMatchObject({
			isArchived: true,
			isPinned: false,
			orderGroup: 'archived',
		});
		expect(store.orderedChats.filter((chat) => chat.isArchived).map((chat) => chat.id)).toEqual([
			'target',
			'archived',
		]);
		expect(store.startArchivingChats(['target']).chatIds).toEqual([]);
		await flushMicrotasks();
		expect(mockToggleArchive).toHaveBeenCalledOnce();

		archive.resolve({ success: true, isArchived: true });
		await flushMicrotasks();
		expect(store.isArchiveMutationPending('target')).toBe(true);
		refresh.resolve({
			sessions: [
				makeServerSession({ id: 'normal' }),
				makeServerSession({ id: 'target', isArchived: true, orderGroup: 'archived' }),
				makeServerSession({ id: 'archived', isArchived: true, orderGroup: 'archived' }),
			],
			total: 3,
			lastSelectedChatId: null,
		});
		await mutation.completion;

		expect(store.isArchiveMutationPending('target')).toBe(false);
		expect(store.orderedChats.filter((chat) => chat.isArchived).map((chat) => chat.id)).toEqual([
			'target',
			'archived',
		]);
	});

	it('uses refreshed server truth when an archive response fails after committing', async () => {
		mockToggleArchive.mockRejectedValue(new Error('response lost'));
		mockListChats.mockResolvedValue({
			sessions: [makeServerSession({ id: 'target', isArchived: true, orderGroup: 'archived' })],
			total: 1,
			lastSelectedChatId: null,
		});
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ id: 'target' })]);

		const mutation = store.startArchivingChats(['target']);
		await expect(mutation.completion).rejects.toThrow('response lost');

		expect(mockListChats).toHaveBeenCalledOnce();
		expect(store.byId.target?.isArchived).toBe(true);
		expect(store.isArchiveMutationPending('target')).toBe(false);
	});

	it('restores the latest local record when archive mutation and recovery refresh fail', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mockToggleArchive.mockRejectedValue(new Error('offline'));
		mockListChats.mockRejectedValue(new Error('refresh offline'));
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'target', title: 'Original' }),
			makeServerSession({ id: 'archived', isArchived: true, orderGroup: 'archived' }),
		]);

		const mutation = store.startArchivingChats(['target']);
		store.patchChat('target', { title: 'Updated while pending' });
		await expect(mutation.completion).rejects.toThrow('offline');

		expect(store.byId.target).toMatchObject({
			title: 'Updated while pending',
			isArchived: false,
			isPinned: false,
			orderGroup: 'normal',
		});
		expect(store.order).toEqual(['target', 'archived']);
	});

	it('keeps an acknowledged archive when reconciliation fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		mockToggleArchive.mockResolvedValue({ success: true, isArchived: true });
		mockListChats.mockRejectedValue(new Error('refresh offline'));
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'target' }),
			makeServerSession({ id: 'archived', isArchived: true, orderGroup: 'archived' }),
		]);

		const mutation = store.startArchivingChats(['target']);
		await mutation.completion;

		expect(store.byId.target).toMatchObject({ isArchived: true, orderGroup: 'archived' });
		expect(store.orderedChats.map((chat) => chat.id)).toEqual(['target', 'archived']);
	});

	it('keeps an acknowledged archive when a tag response settles during failed reconciliation', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const archive = deferred<{ success: boolean; isArchived: boolean }>();
		const refresh = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		const listChats = vi.fn()
			.mockReturnValueOnce(refresh.promise)
			.mockRejectedValueOnce(new Error('follow-up refresh failed'));
		const applyChatTagDelta = vi.fn().mockResolvedValue({
			success: true as const,
			chatId: 'target',
			tags: ['urgent'],
			addedTags: ['urgent'],
			removedTags: [],
		});
		const store = new ChatSessionsStore({
			listChats,
			applyChatTagDelta,
			toggleArchive: () => archive.promise,
		});
		store.upsertFromServer([makeServerSession({ id: 'target' })]);

		const archiveMutation = store.startArchivingChats(['target']);
		await flushMicrotasks();
		archive.resolve({ success: true, isArchived: true });
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledOnce());

		await store.applyChatTagDelta({ chatId: 'target', addTags: ['urgent'] });
		refresh.reject(new Error('refresh failed'));
		await archiveMutation.completion;

		expect(listChats).toHaveBeenCalledTimes(2);
		expect(store.byId.target).toMatchObject({
			isArchived: true,
			orderGroup: 'archived',
			tags: ['urgent'],
		});
	});

	it('uses the final failed follow-up refresh when preserving an acknowledged archive', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const staleRefresh = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		mockListChats
			.mockReturnValueOnce(staleRefresh.promise)
			.mockRejectedValueOnce(new Error('follow-up refresh failed'));
		mockToggleArchive.mockResolvedValue({ success: true, isArchived: true });
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ id: 'target' })]);

		const initialRefresh = store.quietRefreshChats();
		const mutation = store.startArchivingChats(['target']);
		await flushMicrotasks();
		staleRefresh.resolve({
			sessions: [makeServerSession({ id: 'target' })],
			total: 1,
			lastSelectedChatId: null,
		});
		await Promise.all([initialRefresh, mutation.completion]);

		expect(mockListChats).toHaveBeenCalledTimes(2);
		expect(store.byId.target).toMatchObject({ isArchived: true, orderGroup: 'archived' });
		expect(store.isArchiveMutationPending('target')).toBe(false);
	});

	it('preserves newer server truth when a later coalesced refresh fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const firstRefresh = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		const secondArchive = deferred<{ success: boolean; isArchived: boolean }>();
		mockToggleArchive.mockImplementation((chatId) =>
			chatId === 'first'
				? Promise.resolve({ success: true, isArchived: true })
				: secondArchive.promise,
		);
		mockListChats
			.mockReturnValueOnce(firstRefresh.promise)
			.mockRejectedValueOnce(new Error('follow-up refresh failed'));
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'first' }),
			makeServerSession({ id: 'second' }),
		]);

		const firstMutation = store.startArchivingChats(['first']);
		await vi.waitFor(() => expect(mockListChats).toHaveBeenCalledOnce());
		const secondMutation = store.startArchivingChats(['second']);
		secondArchive.resolve({ success: true, isArchived: true });
		await flushMicrotasks();
		firstRefresh.resolve({
			sessions: [
				makeServerSession({ id: 'first', isPinned: true, orderGroup: 'pinned' }),
				makeServerSession({ id: 'second' }),
			],
			total: 2,
			lastSelectedChatId: null,
		});
		await Promise.all([firstMutation.completion, secondMutation.completion]);

		expect(mockListChats).toHaveBeenCalledTimes(2);
		expect(store.byId.first).toMatchObject({
			isArchived: false,
			isPinned: true,
			orderGroup: 'pinned',
		});
		expect(store.byId.second?.isArchived).toBe(true);
	});

	it('preserves newer server truth for an early-settling bulk archive', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const firstArchive = deferred<{ success: boolean; isArchived: boolean }>();
		const secondArchive = deferred<{ success: boolean; isArchived: boolean }>();
		mockToggleArchive.mockImplementation((chatId) =>
			chatId === 'first' ? firstArchive.promise : secondArchive.promise,
		);
		mockListChats
			.mockResolvedValueOnce({
				sessions: [
					makeServerSession({ id: 'first', isPinned: true, orderGroup: 'pinned' }),
					makeServerSession({ id: 'second' }),
				],
				total: 2,
				lastSelectedChatId: null,
			})
			.mockRejectedValueOnce(new Error('final refresh failed'));
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'first' }),
			makeServerSession({ id: 'second' }),
		]);

		const mutation = store.startArchivingChats(['first', 'second']);
		await flushMicrotasks();
		firstArchive.resolve({ success: true, isArchived: true });
		await flushMicrotasks();
		await store.quietRefreshChats();

		secondArchive.resolve({ success: true, isArchived: true });
		await mutation.completion;

		expect(mockListChats).toHaveBeenCalledTimes(2);
		expect(store.byId.first).toMatchObject({
			isArchived: false,
			isPinned: true,
			orderGroup: 'pinned',
		});
		expect(store.byId.second?.isArchived).toBe(true);
	});

	it('preserves a newer single-chat server response after a bulk member settles', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const secondArchive = deferred<{ success: boolean; isArchived: boolean }>();
		mockToggleArchive.mockImplementation((chatId) =>
			chatId === 'first'
				? Promise.resolve({ success: true, isArchived: true })
				: secondArchive.promise,
		);
		mockListChats.mockRejectedValue(new Error('final refresh failed'));
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'first' }),
			makeServerSession({ id: 'second' }),
		]);

		const mutation = store.startArchivingChats(['first', 'second']);
		await flushMicrotasks();
		store.upsertServerChat(
			makeServerSession({ id: 'first', isPinned: true, orderGroup: 'pinned' }),
		);
		secondArchive.resolve({ success: true, isArchived: true });
		await mutation.completion;

		expect(store.byId.first).toMatchObject({
			isArchived: false,
			isPinned: true,
			orderGroup: 'pinned',
		});
		expect(store.byId.second?.isArchived).toBe(true);
	});

	it('keeps a newer optimistic archive when disjoint operations settle in reverse order', async () => {
		const firstArchive = deferred<{ success: boolean; isArchived: boolean }>();
		const secondArchive = deferred<{ success: boolean; isArchived: boolean }>();
		mockToggleArchive.mockImplementation((chatId) =>
			chatId === 'first' ? firstArchive.promise : secondArchive.promise,
		);
		mockListChats
			.mockResolvedValueOnce({
				sessions: [
					makeServerSession({ id: 'first' }),
					makeServerSession({ id: 'second', isArchived: true, orderGroup: 'archived' }),
				],
				total: 2,
				lastSelectedChatId: null,
			})
			.mockResolvedValueOnce({
				sessions: [
					makeServerSession({ id: 'first', isArchived: true, orderGroup: 'archived' }),
					makeServerSession({ id: 'second', isArchived: true, orderGroup: 'archived' }),
				],
				total: 2,
				lastSelectedChatId: null,
			});
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'first' }),
			makeServerSession({ id: 'second' }),
		]);

		const firstMutation = store.startArchivingChats(['first']);
		const secondMutation = store.startArchivingChats(['second']);
		expect(store.orderedChats.map((chat) => chat.id)).toEqual(['second', 'first']);

		secondArchive.resolve({ success: true, isArchived: true });
		await secondMutation.completion;
		expect(store.byId.first?.isArchived).toBe(true);
		expect(store.isArchiveMutationPending('first')).toBe(true);
		expect(store.isArchiveMutationPending('second')).toBe(false);

		firstArchive.resolve({ success: true, isArchived: true });
		await firstMutation.completion;
		expect(store.orderedChats.map((chat) => chat.id)).toEqual(['first', 'second']);
		expect(store.isArchiveMutationPending('first')).toBe(false);
	});

	it('waits for every bulk archive result before one recovery refresh', async () => {
		const first = deferred<{ success: boolean; isArchived: boolean }>();
		const second = deferred<{ success: boolean; isArchived: boolean }>();
		mockToggleArchive.mockImplementation((chatId) => {
			return chatId === 'first' ? first.promise : second.promise;
		});
		mockListChats.mockResolvedValue({
			sessions: [
				makeServerSession({ id: 'first' }),
				makeServerSession({ id: 'second', isArchived: true, orderGroup: 'archived' }),
			],
			total: 2,
			lastSelectedChatId: null,
		});
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'first' }),
			makeServerSession({ id: 'second' }),
		]);

		const mutation = store.startArchivingChats(['first', 'second']);
		first.reject(new Error('first failed'));
		await Promise.resolve();
		expect(mockListChats).not.toHaveBeenCalled();
		expect(store.isArchiveMutationPending('first')).toBe(true);
		expect(store.isArchiveMutationPending('second')).toBe(true);

		second.resolve({ success: true, isArchived: true });
		await expect(mutation.completion).rejects.toThrow('first failed');

		expect(mockListChats).toHaveBeenCalledOnce();
		expect(store.byId.first?.isArchived).toBe(false);
		expect(store.byId.second?.isArchived).toBe(true);
		expect(store.isArchiveMutationPending('first')).toBe(false);
		expect(store.isArchiveMutationPending('second')).toBe(false);
	});

	it('keeps unarchive placement unchanged until the mutation reconciles', async () => {
		const unarchive = deferred<{ success: boolean; isArchived: boolean }>();
		mockToggleArchive.mockReturnValue(unarchive.promise);
		mockListChats.mockResolvedValue({
			sessions: [makeServerSession({ id: 'target', orderGroup: 'normal' })],
			total: 1,
			lastSelectedChatId: null,
		});
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'archived-first', isArchived: true, orderGroup: 'archived' }),
			makeServerSession({ id: 'target', isArchived: true, orderGroup: 'archived' }),
		]);

		const mutation = store.startUnarchivingChats(['target']);

		expect(store.byId.target?.isArchived).toBe(true);
		expect(store.isArchiveMutationPending('target')).toBe(true);
		expect(store.isChatOptimisticallyArchived('target')).toBe(false);
		expect(store.order).toEqual(['archived-first', 'target']);
		expect(store.startArchivingChats(['target']).chatIds).toEqual([]);
		unarchive.resolve({ success: true, isArchived: false });
		await mutation.completion;

		expect(store.byId.target?.isArchived).toBe(false);
		expect(store.isArchiveMutationPending('target')).toBe(false);
	});

	it('retains archive ownership while a removed chat is restored', async () => {
		const archive = deferred<{ success: boolean; isArchived: boolean }>();
		mockToggleArchive.mockReturnValue(archive.promise);
		mockListChats.mockResolvedValue({
			sessions: [makeServerSession({ id: 'target', isArchived: true, orderGroup: 'archived' })],
			total: 1,
			lastSelectedChatId: null,
		});
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ id: 'target' })]);
		const mutation = store.startArchivingChats(['target']);

		store.removeChat('target');
		expect(store.isArchiveMutationPending('target')).toBe(true);
		await store.quietRefreshChats();
		expect(store.startUnarchivingChats(['target']).chatIds).toEqual([]);
		archive.resolve({ success: true, isArchived: true });
		await mutation.completion;

		expect(mockToggleArchive).toHaveBeenCalledOnce();
		expect(store.byId.target).toMatchObject({ isArchived: true, orderGroup: 'archived' });
		expect(store.isArchiveMutationPending('target')).toBe(false);
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
		mockUpdateSessionName.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			title: 'Updated title',
			changed: true,
		});

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
		mockReplaceChatTags.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			tags: ['existing', 'urgent'],
			addedTags: ['urgent'],
			removedTags: [],
		});
		mockListChats.mockResolvedValue({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['existing', 'urgent'] })],
			total: 1,
			lastSelectedChatId: 'chat-1',
		});

		await expect(store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['existing'],
			tags: ['existing', 'urgent'],
		})).resolves.toMatchObject({ success: true });

		expect(mockReplaceChatTags).toHaveBeenCalledWith({
			chatId: 'chat-1',
			expectedTags: ['existing'],
			tags: ['existing', 'urgent'],
		});
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
		mockReplaceChatTags.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			tags: ['existing', 'urgent'],
			addedTags: ['urgent'],
			removedTags: [],
		});

		const initialRefresh = store.quietRefreshChats();
		const mutation = store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['existing'],
			tags: ['existing', 'urgent'],
		});
		await Promise.resolve();
		staleFetch.resolve({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['existing'] })],
			total: 1,
			lastSelectedChatId: 'chat-1',
		});

		await expect(Promise.all([initialRefresh, mutation])).resolves.toEqual([
			undefined,
			expect.objectContaining({ success: true }),
		]);
		expect(mockListChats).toHaveBeenCalledTimes(2);
		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);
	});

	it('retains a reconciliation fence until a post-settlement chat-list read succeeds', async () => {
		const staleFetch = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		const mutation = deferred<{
			success: true;
			chatId: string;
			tags: string[];
			addedTags: string[];
			removedTags: string[];
		}>();
		const listChats = vi.fn()
			.mockReturnValueOnce(staleFetch.promise)
			.mockRejectedValueOnce(new Error('refresh failed'))
			.mockResolvedValueOnce({
				sessions: [makeServerSession({ id: 'chat-1', tags: ['existing', 'urgent'] })],
				total: 1,
				lastSelectedChatId: null,
			});
		const replaceChatTags = vi.fn(() => mutation.promise);
		const store = new ChatSessionsStore({ listChats, replaceChatTags });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['existing'] })]);

		const oldListRequest = store.quietRefreshChats();
		const tagMutation = store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['existing'],
			tags: ['existing', 'urgent'],
		});
		staleFetch.resolve({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['existing'] })],
			total: 1,
			lastSelectedChatId: null,
		});
		await oldListRequest;
		mutation.resolve({
			success: true,
			chatId: 'chat-1',
			tags: ['existing', 'urgent'],
			addedTags: ['urgent'],
			removedTags: [],
		});

		await expect(tagMutation).resolves.toMatchObject({ success: true });
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledTimes(2));
		expect(store.byId['chat-1'].tags).toEqual(['existing']);
		expect(store.tagReconciliationKind('chat-1')).toBe('committed-refresh');
		await expect(store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['existing'],
			tags: ['review'],
		})).rejects.toMatchObject({ reconciliationKind: 'committed-refresh' });
		expect(replaceChatTags).toHaveBeenCalledTimes(1);

		await expect(store.retryTagReconciliation('chat-1')).resolves.toBeUndefined();
		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);
		expect(store.tagReconciliationKind('chat-1')).toBeNull();
	});

	it('preserves a successful tag mutation when its convergence refresh fails', async () => {
		const notifyError = vi.fn();
		const store = new ChatSessionsStore({ notifyError });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['existing'] })]);
		mockReplaceChatTags.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			tags: ['existing', 'urgent'],
			addedTags: ['urgent'],
			removedTags: [],
		});
		mockListChats.mockRejectedValue(new Error('refresh failed'));

		await expect(store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['existing'],
			tags: ['existing', 'urgent'],
		})).resolves.toMatchObject({ success: true });

		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);
		expect(notifyError).toHaveBeenCalledWith('Failed to refresh chats.');
	});

	it('does not let a pre-settlement list response replace acknowledged tags', async () => {
		const staleFetch = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		const listChats = vi.fn()
			.mockReturnValueOnce(staleFetch.promise)
			.mockRejectedValueOnce(new Error('refresh failed'));
		const replaceChatTags = vi.fn().mockResolvedValue({
			success: true as const,
			chatId: 'chat-1',
			tags: ['existing', 'urgent'],
			addedTags: ['urgent'],
			removedTags: [],
		});
		const store = new ChatSessionsStore({ listChats, replaceChatTags });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['existing'] })]);

		const oldListRequest = store.quietRefreshChats();
		await expect(store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['existing'],
			tags: ['existing', 'urgent'],
		})).resolves.toMatchObject({ success: true });
		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);

		staleFetch.resolve({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['existing'] })],
			total: 1,
			lastSelectedChatId: null,
		});
		await oldListRequest;

		expect(listChats).toHaveBeenCalledTimes(2);
		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);
		expect(store.tagReconciliationKind('chat-1')).toBeNull();
	});

	it('does not let a pre-recovery list response replace confirmed tags', async () => {
		const staleFetch = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		const recovery = deferred<{ success: true; chatId: string; tags: string[] }>();
		const listChats = vi.fn()
			.mockReturnValueOnce(staleFetch.promise)
			.mockRejectedValueOnce(new Error('refresh failed'));
		const unknown = new ApiError(503, 'Confirmation required', 'CHAT_TAG_SAVE_UNKNOWN');
		const store = new ChatSessionsStore({
			listChats,
			applyChatTagDelta: vi.fn().mockRejectedValue(unknown),
			recoverChatTags: vi.fn(() => recovery.promise),
		});
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['existing'] })]);

		const oldListRequest = store.quietRefreshChats();
		await expect(store.applyChatTagDelta({
			chatId: 'chat-1',
			addTags: ['urgent'],
		})).rejects.toBe(unknown);
		recovery.resolve({ success: true, chatId: 'chat-1', tags: ['existing', 'urgent'] });
		await vi.waitFor(() => expect(store.tagReconciliationKind('chat-1')).toBeNull());
		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);

		staleFetch.resolve({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['existing'] })],
			total: 1,
			lastSelectedChatId: null,
		});
		await oldListRequest;

		expect(listChats).toHaveBeenCalledTimes(2);
		expect(store.byId['chat-1'].tags).toEqual(['existing', 'urgent']);
		expect(store.tagReconciliationKind('chat-1')).toBeNull();
	});

	it('reports a failed persisted tag mutation without changing local tags', async () => {
		const notifyError = vi.fn();
		const store = new ChatSessionsStore({ notifyError });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['existing'] })]);
		mockReplaceChatTags.mockRejectedValue(new Error('tag update failed'));

		await expect(store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['existing'],
			tags: ['urgent'],
		})).rejects.toThrow('tag update failed');

		expect(store.byId['chat-1'].tags).toEqual(['existing']);
	});

	it('reconciles authoritative tags from a replacement conflict without WebSocket delivery', async () => {
		const conflict = new ApiError(
			409,
			'Chat tags changed',
			'CHAT_TAG_REVISION_CONFLICT',
			undefined,
			true,
			{
				success: false,
				error: 'Chat tags changed',
				errorCode: 'CHAT_TAG_REVISION_CONFLICT',
				retryable: true,
				currentTags: ['approved', 'ready'],
			},
		);
		const replaceChatTags = vi.fn().mockRejectedValue(conflict);
		const listChats = vi.fn().mockResolvedValue({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['approved', 'ready'] })],
			total: 1,
			lastSelectedChatId: null,
		});
		const store = new ChatSessionsStore({ replaceChatTags, listChats });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);

		await expect(store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['ready'],
			tags: ['ready', 'urgent'],
		})).rejects.toBe(conflict);

		expect(store.byId['chat-1'].tags).toEqual(['approved', 'ready']);
		expect(replaceChatTags).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledOnce());
	});

	it('distinguishes a rejected conflict that still needs a canonical refresh', async () => {
		const conflict = new ApiError(
			409,
			'Chat tags changed',
			'CHAT_TAG_REVISION_CONFLICT',
			undefined,
			true,
			{
				success: false,
				error: 'Chat tags changed',
				errorCode: 'CHAT_TAG_REVISION_CONFLICT',
				retryable: true,
				currentTags: ['approved', 'ready'],
			},
		);
		const mutation = deferred<never>();
		const listChats = vi.fn().mockRejectedValue(new Error('refresh failed'));
		const store = new ChatSessionsStore({
			replaceChatTags: vi.fn(() => mutation.promise),
			listChats,
		});
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);

		const pending = store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['ready'],
			tags: ['ready', 'urgent'],
		});
		store.upsertServerChat(makeServerSession({ id: 'chat-1', tags: ['newer'] }));
		mutation.reject(conflict);

		await expect(pending).rejects.toBe(conflict);
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledTimes(1));
		expect(store.byId['chat-1'].tags).toEqual(['newer']);
		expect(store.tagReconciliationKind('chat-1')).toBe('conflict-refresh');
	});

	it('marks every tag writer pending and enters recovery after an unknown outcome', async () => {
		const mutation = deferred<{
			success: true;
			chatId: string;
			tags: string[];
			addedTags: string[];
			removedTags: string[];
		}>();
		const recovery = deferred<{ success: true; chatId: string; tags: string[] }>();
		const store = new ChatSessionsStore({
			replaceChatTags: () => mutation.promise,
			recoverChatTags: () => recovery.promise,
		});
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);

		const pending = store.replaceChatTags({
			chatId: 'chat-1', expectedTags: ['ready'], tags: ['review'],
		});
		expect(store.pendingTagMutationChatIds.has('chat-1')).toBe(true);
		mutation.reject(new ApiError(503, 'Confirmation required', 'CHAT_TAG_SAVE_UNKNOWN'));
		await expect(pending).rejects.toMatchObject({ errorCode: 'CHAT_TAG_SAVE_UNKNOWN' });
		expect(store.pendingTagMutationChatIds.has('chat-1')).toBe(false);
		expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(true);

		recovery.resolve({ success: true, chatId: 'chat-1', tags: ['review'] });
		await vi.waitFor(() => expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(false));
		expect(store.byId['chat-1'].tags).toEqual(['review']);
	});

	it('coalesces durability recovery and rejects writers while confirmation is required', async () => {
		const recovery = deferred<{ success: true; chatId: string; tags: string[] }>();
		const recoverChatTags = vi.fn(() => recovery.promise);
		const unknown = new ApiError(503, 'Confirmation required', 'CHAT_TAG_SAVE_UNKNOWN');
		const replaceChatTags = vi.fn().mockRejectedValue(unknown);
		const fenced = new ChatSessionsStore({ replaceChatTags, recoverChatTags });
		fenced.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);
		await expect(fenced.replaceChatTags({
			chatId: 'chat-1', expectedTags: ['ready'], tags: ['review'],
		})).rejects.toBe(unknown);

		const first = fenced.recoverChatTags('chat-1');
		const second = fenced.recoverChatTags('chat-1');
		expect(recoverChatTags).toHaveBeenCalledTimes(1);
		await expect(fenced.applyChatTagDelta({
			chatId: 'chat-1', addTags: ['urgent'],
		})).rejects.toEqual(new ChatTagMutationBlockedError('durability'));
		recovery.resolve({ success: true, chatId: 'chat-1', tags: ['review'] });
		await Promise.all([first, second]);
	});

	it('does not use a list refresh to settle a newer durability outcome', async () => {
		const firstRecovery = deferred<{ success: true; chatId: string; tags: string[] }>();
		const secondRecovery = deferred<{ success: true; chatId: string; tags: string[] }>();
		const listRefresh = deferred<{
			sessions: ChatSession[];
			total: number;
			lastSelectedChatId: string | null;
		}>();
		const recoverChatTags = vi.fn()
			.mockReturnValueOnce(firstRecovery.promise)
			.mockReturnValueOnce(secondRecovery.promise);
		const listChats = vi.fn(() => listRefresh.promise);
		const store = new ChatSessionsStore({ listChats, recoverChatTags });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);
		const unknownOutcome = {
			status: 'unknown',
			errorCode: 'CHAT_TAG_SAVE_UNKNOWN',
			recoveryRequired: true,
		} as const;

		await store.observeCommandTagMutation('chat-1', unknownOutcome);
		const firstConfirmation = store.recoverChatTags('chat-1');
		const observeNewerOutcome = firstConfirmation.then(() =>
			store.observeCommandTagMutation('chat-1', unknownOutcome),
		);
		const retry = store.retryTagReconciliation('chat-1');
		const retryRejected = vi.fn();
		void retry.catch(retryRejected);

		firstRecovery.resolve({ success: true, chatId: 'chat-1', tags: ['review'] });
		await observeNewerOutcome;
		await flushMicrotasks();
		expect(retryRejected).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Saved tags could not be refreshed' }),
		);
		expect(listChats).toHaveBeenCalledTimes(1);
		expect(store.tagReconciliationKind('chat-1')).toBe('durability');

		listRefresh.resolve({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['review'] })],
			total: 1,
			lastSelectedChatId: null,
		});
		secondRecovery.resolve({ success: true, chatId: 'chat-1', tags: ['review'] });
		await vi.waitFor(() => expect(store.tagReconciliationKind('chat-1')).toBeNull());
	});

	it('treats a transport failure after dispatch as an unknown tag outcome', async () => {
		const recovery = deferred<{ success: true; chatId: string; tags: string[] }>();
		const recoverChatTags = vi.fn(() => recovery.promise);
		const applyChatTagDelta = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		const store = new ChatSessionsStore({ applyChatTagDelta, recoverChatTags });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);

		await expect(store.applyChatTagDelta({
			chatId: 'chat-1', addTags: ['review'],
		})).rejects.toThrow('Failed to fetch');

		expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(true);
		expect(recoverChatTags).toHaveBeenCalledTimes(1);
		recovery.resolve({ success: true, chatId: 'chat-1', tags: ['review'] });
		await vi.waitFor(() => expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(false));
	});

	it('requires another recovery response after a newer unknown tag outcome', async () => {
		const firstRecovery = deferred<{ success: true; chatId: string; tags: string[] }>();
		const secondRecovery = deferred<{ success: true; chatId: string; tags: string[] }>();
		const secondMutation = deferred<never>();
		const recoverChatTags = vi.fn()
			.mockImplementationOnce(() => firstRecovery.promise)
			.mockImplementationOnce(() => secondRecovery.promise);
		const unknown = new ApiError(503, 'Confirmation required', 'CHAT_TAG_SAVE_UNKNOWN');
		const applyChatTagDelta = vi.fn()
			.mockRejectedValueOnce(unknown)
			.mockImplementationOnce(() => secondMutation.promise);
		const store = new ChatSessionsStore({ applyChatTagDelta, recoverChatTags });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);

		const first = store.applyChatTagDelta({ chatId: 'chat-1', addTags: ['alpha'] });
		const second = store.applyChatTagDelta({ chatId: 'chat-1', addTags: ['beta'] });
		await expect(first).rejects.toBe(unknown);
		secondMutation.reject(unknown);
		await expect(second).rejects.toBe(unknown);
		const confirmation = store.recoverChatTags('chat-1');

		firstRecovery.resolve({ success: true, chatId: 'chat-1', tags: ['alpha'] });
		await vi.waitFor(() => expect(recoverChatTags).toHaveBeenCalledTimes(2));
		expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(true);
		expect(store.byId['chat-1'].tags).toEqual(['ready']);

		secondRecovery.resolve({ success: true, chatId: 'chat-1', tags: ['beta'] });
		await confirmation;
		expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(false);
		expect(store.byId['chat-1'].tags).toEqual(['beta']);
	});

	it('allows an explicit confirmation retry after automatic recovery fails', async () => {
		const unknown = new ApiError(503, 'Confirmation required', 'CHAT_TAG_SAVE_UNKNOWN');
		const recoverChatTags = vi.fn()
			.mockRejectedValueOnce(new TypeError('Offline'))
			.mockResolvedValueOnce({ success: true, chatId: 'chat-1', tags: ['review'] });
		const applyChatTagDelta = vi.fn().mockRejectedValueOnce(unknown);
		const store = new ChatSessionsStore({ applyChatTagDelta, recoverChatTags });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);

		await expect(store.applyChatTagDelta({
			chatId: 'chat-1', addTags: ['review'],
		})).rejects.toBe(unknown);
		await flushMicrotasks();
		expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(true);

		await expect(store.recoverChatTags('chat-1')).resolves.toMatchObject({ tags: ['review'] });
		expect(recoverChatTags).toHaveBeenCalledTimes(2);
		expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(false);
	});

	it.each([
		{
			name: 'an untyped gateway failure',
			error: new ApiError(504, 'Gateway Timeout'),
		},
		{
			name: 'malformed successful JSON',
			error: new ApiMutationOutcomeUnknownError('The response was not valid JSON'),
		},
		{
			name: 'an invalid successful envelope',
			error: new ApiMutationOutcomeUnknownError('Invalid chat tag mutation response'),
		},
	])('fences writers and starts recovery after $name', async ({ error }) => {
		const recovery = deferred<{ success: true; chatId: string; tags: string[] }>();
		const recoverChatTags = vi.fn(() => recovery.promise);
		const applyChatTagDelta = vi.fn().mockRejectedValue(error);
		const replaceChatTags = vi.fn();
		const store = new ChatSessionsStore({ applyChatTagDelta, recoverChatTags, replaceChatTags });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);

		await expect(store.applyChatTagDelta({
			chatId: 'chat-1',
			addTags: ['review'],
		})).rejects.toBe(error);

		expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(true);
		expect(recoverChatTags).toHaveBeenCalledTimes(1);
		await expect(store.replaceChatTags({
			chatId: 'chat-1',
			expectedTags: ['ready'],
			tags: ['urgent'],
		})).rejects.toEqual(new ChatTagMutationBlockedError('durability'));
		expect(replaceChatTags).not.toHaveBeenCalled();
		expect(applyChatTagDelta).toHaveBeenCalledTimes(1);

		recovery.resolve({ success: true, chatId: 'chat-1', tags: ['review'] });
		await vi.waitFor(() => expect(store.tagRecoveryRequiredChatIds.has('chat-1')).toBe(false));
	});

	it('keeps the pending tag projection until every concurrent writer settles', async () => {
		const firstMutation = deferred<never>();
		const secondMutation = deferred<never>();
		const applyChatTagDelta = vi.fn()
			.mockImplementationOnce(() => firstMutation.promise)
			.mockImplementationOnce(() => secondMutation.promise);
		const store = new ChatSessionsStore({ applyChatTagDelta });
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);

		const first = store.applyChatTagDelta({ chatId: 'chat-1', addTags: ['alpha'] });
		const second = store.applyChatTagDelta({ chatId: 'chat-1', addTags: ['beta'] });
		expect(store.pendingTagMutationChatIds.has('chat-1')).toBe(true);
		firstMutation.reject(new Error('First failed'));
		await expect(first).rejects.toThrow('First failed');
		expect(store.pendingTagMutationChatIds.has('chat-1')).toBe(true);
		secondMutation.reject(new Error('Second failed'));
		await expect(second).rejects.toThrow('Second failed');
		expect(store.pendingTagMutationChatIds.has('chat-1')).toBe(false);
	});

	it('does not install an older tag response after newer server reconciliation', async () => {
		const mutation = deferred<{
			success: true;
			chatId: string;
			tags: string[];
			addedTags: string[];
			removedTags: string[];
		}>();
		const listChats = vi.fn().mockResolvedValue({
			sessions: [makeServerSession({ id: 'chat-1', tags: ['newer'] })],
			total: 1,
			lastSelectedChatId: null,
		});
		const store = new ChatSessionsStore({
			replaceChatTags: () => mutation.promise,
			listChats,
		});
		store.upsertFromServer([makeServerSession({ id: 'chat-1', tags: ['ready'] })]);
		const pending = store.replaceChatTags({
			chatId: 'chat-1', expectedTags: ['ready'], tags: ['older'],
		});
		store.upsertServerChat(makeServerSession({ id: 'chat-1', tags: ['newer'] }));
		mutation.resolve({
			success: true,
			chatId: 'chat-1',
			tags: ['older'],
			addedTags: ['older'],
			removedTags: ['ready'],
		});
		await pending;
		await vi.waitFor(() => expect(listChats).toHaveBeenCalled());
		expect(store.byId['chat-1'].tags).toEqual(['newer']);
	});

	it('preserves canonical chat fields when reconciling a delayed handoff projection', async () => {
		const listChats = vi.fn().mockResolvedValue({ sessions: [], total: 0, lastSelectedChatId: null });
		const store = new ChatSessionsStore({ listChats });
		store.upsertFromServer([makeServerSession({
			id: 'chat-1', title: 'Current title', tags: ['newer'], agentId: 'claude', model: 'sonnet',
		})]);

		store.reconcileAcceptedHandoffProjection(makeServerSession({
			id: 'chat-1', title: 'Stale title', tags: ['older'], agentId: 'codex', model: 'gpt-5.5',
		}));

		expect(store.byId['chat-1']).toMatchObject({
			title: 'Current title',
			tags: ['newer'],
			agentId: 'codex',
			model: 'gpt-5.5',
		});
		await vi.waitFor(() => expect(listChats).toHaveBeenCalledTimes(1));
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
