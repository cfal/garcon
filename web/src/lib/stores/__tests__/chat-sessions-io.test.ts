import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionsStore } from '../chat-sessions.svelte';
import type { ChatSession } from '$lib/types/session';

vi.mock('$lib/api/chats.js', () => ({
	listChats: vi.fn(),
	getRunningChats: vi.fn(),
	deleteChat: vi.fn(),
}));

vi.mock('$lib/api/settings.js', () => ({
	updateSessionName: vi.fn(),
}));

import { deleteChat, getRunningChats, listChats } from '$lib/api/chats.js';
import { updateSessionName } from '$lib/api/settings.js';

const mockListChats = vi.mocked(listChats);
const mockGetRunningChats = vi.mocked(getRunningChats);
const mockDeleteChat = vi.mocked(deleteChat);
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
		tags: [],
		permissionMode: 'default',
		thinkingMode: 'none',
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isUnread: false,
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		...overrides,
	};
}

describe('ChatSessionsStore IO', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refreshChats fetches sessions and clears loading state', async () => {
		const store = new ChatSessionsStore();
		const sessions = [makeServerSession({ id: 'chat-1' })];
		mockListChats.mockResolvedValue({ sessions, total: 1 });

		await store.refreshChats();

		expect(store.byId['chat-1']?.id).toBe('chat-1');
		expect(store.isLoadingChats).toBe(false);
	});

	it('quietRefreshChats does not enable loading state', async () => {
		const store = new ChatSessionsStore();
		store.isLoadingChats = false;
		mockListChats.mockResolvedValue({
			sessions: [makeServerSession({ id: 'chat-2', title: 'Quiet' })],
			total: 1,
		});

		await store.quietRefreshChats();

		expect(store.byId['chat-2']?.title).toBe('Quiet');
		expect(store.isLoadingChats).toBe(false);
	});

	it('runs a follow-up fetch when refresh is requested during an in-flight fetch', async () => {
		const store = new ChatSessionsStore();
		const first = deferred<{ sessions: ChatSession[]; total: number }>();
		const staleSessions = [makeServerSession({ id: 'stale', title: 'Stale' })];
		const freshSessions = [makeServerSession({ id: 'fresh', title: 'Fresh' })];
		mockListChats
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce({ sessions: freshSessions, total: 1 });

		const firstRefresh = store.quietRefreshChats();
		const secondRefresh = store.quietRefreshChats();
		first.resolve({ sessions: staleSessions, total: 1 });
		await Promise.all([firstRefresh, secondRefresh]);

		expect(mockListChats).toHaveBeenCalledTimes(2);
		expect(store.byId['fresh']?.title).toBe('Fresh');
		expect(store.byId['stale']).toBeUndefined();
	});

	it('reconciles processing after refreshing sessions', async () => {
		const store = new ChatSessionsStore();
		mockListChats.mockResolvedValue({
			sessions: [
				makeServerSession({ id: 'chat-a', title: 'A' }),
				makeServerSession({ id: 'chat-b', title: 'B' }),
			],
			total: 2,
		});
		mockGetRunningChats.mockResolvedValue({
			sessions: {
				claude: [{ id: 'chat-b' }],
			},
		});

		await store.refreshChatsAndReconcileProcessing();

		expect(store.byId['chat-a']?.isProcessing).toBe(false);
		expect(store.byId['chat-b']?.isProcessing).toBe(true);
	});

	it('notifies and refreshes when remote delete fails', async () => {
		const notifyError = vi.fn();
		const store = new ChatSessionsStore({ notifyError });
		mockDeleteChat.mockRejectedValue(new Error('delete failed'));
		mockListChats.mockResolvedValue({ sessions: [], total: 0 });

		await store.deleteRemoteChat('chat-1');
		await Promise.resolve();

		expect(notifyError).toHaveBeenCalledWith('Failed to delete chat.');
		expect(mockListChats).toHaveBeenCalledTimes(1);
	});

	it('notifies when remote rename fails', async () => {
		const notifyError = vi.fn();
		const store = new ChatSessionsStore({ notifyError });
		mockUpdateSessionName.mockRejectedValue(new Error('rename failed'));

		await store.renameChat('chat-1', 'New Title');

		expect(mockUpdateSessionName).toHaveBeenCalledWith('chat-1', 'New Title');
		expect(notifyError).toHaveBeenCalledWith('Failed to rename chat.');
	});
});
