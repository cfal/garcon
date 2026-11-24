import { describe, expect, it, vi } from 'vitest';
import { ChatSessionsStore } from '../chat-sessions.svelte';
import type { ChatSessionsStoreDeps } from '../chat-sessions-contract.js';
import type { ChatListEntry, ChatListResponse } from '$shared/chat-list';

function entry(id: string, activityStatus: ChatListEntry['activityStatus'] = null): ChatListEntry {
	return {
		id,
		agentId: 'claude',
		agentOwnershipEpoch: 'epoch-1',
		parentChatId: null,
		lineage: null,
		model: 'synthetic-model',
		title: 'Synthetic chat',
		projectPath: '/project',
		orderGroup: 'normal',
		tags: [],
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isProcessing: false,
		processingPhase: null,
		activityStatus,
		canReloadFromNativeHistory: false,
		isUnread: false,
	};
}

function response(...sessions: ChatListEntry[]): ChatListResponse {
	return { sessions, total: sessions.length, lastSelectedChatId: null };
}

function deferredList() {
	let resolve!: (value: ChatListResponse) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<ChatListResponse>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('ChatSessionsStore activity snapshot reconciliation', () => {
	it('hydrates every consecutive response despite events for known, unknown and unchanged chats', async () => {
		const listChats = vi.fn<NonNullable<ChatSessionsStoreDeps['listChats']>>();
		const store = new ChatSessionsStore({ listChats });

		for (const [index, activityStatus] of (['working', 'pending-user-action', null] as const).entries()) {
			const pending = deferredList();
			listChats.mockReturnValueOnce(pending.promise);
			const refreshing = store.refreshChats();
			store.patchChat('first', { activityStatus });
			store.patchChat('first', { activityStatus });
			store.patchChat('second', { activityStatus: 'error' });
			store.patchChat('absent', { activityStatus: 'complete' });
			pending.resolve(response(
				{ ...entry('first', 'complete'), title: `Fetched ${index}` },
				entry('second'),
			));
			await refreshing;

			expect(listChats).toHaveBeenCalledTimes(index + 1);
			expect(store.chatListStatus).toBe('ready');
			expect(store.isLoadingChats).toBe(false);
			expect(store.byId.first).toMatchObject({ title: `Fetched ${index}`, activityStatus });
			expect(store.byId.second.activityStatus).toBe('error');
			expect(store.byId.absent).toBeUndefined();
		}

		listChats.mockResolvedValueOnce(response(entry('first', 'complete'), entry('absent', 'working')));
		await store.quietRefreshChats();
		expect(listChats).toHaveBeenCalledTimes(4);
		expect(store.byId.first.activityStatus).toBe('complete');
		expect(store.byId.absent.activityStatus).toBe('working');
		expect(store.byId.second).toBeUndefined();
	});

	it('keeps the roster stable for a duplicate completion without suppressing mixed patches', () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			entry('foreground'),
			{ ...entry('receiver', 'working'), isProcessing: true, processingPhase: 'running' },
		]);
		const working = store.byId.receiver;
		store.patchChat('receiver', { activityStatus: 'complete' });
		expect(store.byId.receiver).not.toBe(working);
		expect(store.byId.receiver.activityStatus).toBe('complete');
		store.applyProcessingEvent('receiver', null);
		const idle = store.byId;
		const roster = store.orderedChats;
		store.patchChat('receiver', { activityStatus: 'complete' });
		expect(store.byId).toBe(idle);
		expect(store.orderedChats).toBe(roster);
		expect(store.byId.receiver.processingPhase).toBeNull();

		store.patchChat('receiver', { activityStatus: 'complete', title: 'Updated title' });
		expect(store.byId.receiver.title).toBe('Updated title');
		expect(store.byId.foreground).toBe(idle.foreground);
	});

	it('retains unchanged activity events without discarding unrelated fetched fields', async () => {
		const pending = deferredList();
		const listChats = vi.fn<NonNullable<ChatSessionsStoreDeps['listChats']>>()
			.mockReturnValueOnce(pending.promise);
		const store = new ChatSessionsStore({ listChats });
		store.upsertFromServer([entry('first', 'working'), entry('second', 'complete')]);

		const refreshing = store.quietRefreshChats();
		store.patchChat('first', { activityStatus: 'working' });
		pending.resolve(response(
			{ ...entry('first', 'error'), title: 'Updated title' },
			entry('second', 'error'),
		));
		await refreshing;

		expect(listChats).toHaveBeenCalledOnce();
		expect(store.byId.first).toMatchObject({ title: 'Updated title', activityStatus: 'working' });
		expect(store.byId.second.activityStatus).toBe('error');
	});

	it('honors authoritative list deletion and expires events before a later reappearance', async () => {
		const pending = deferredList();
		const listChats = vi.fn<NonNullable<ChatSessionsStoreDeps['listChats']>>()
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce(response(entry('deleted', 'complete')));
		const store = new ChatSessionsStore({ listChats });
		store.upsertFromServer([entry('deleted')]);

		const refreshing = store.quietRefreshChats();
		store.patchChat('deleted', { activityStatus: 'error' });
		pending.resolve(response());
		await refreshing;
		expect(store.byId.deleted).toBeUndefined();

		await store.quietRefreshChats();
		expect(listChats).toHaveBeenCalledTimes(2);
		expect(store.byId.deleted.activityStatus).toBe('complete');
	});

	it('prevents an in-flight list from restoring a removed chat', async () => {
		const pending = deferredList();
		const listChats = vi.fn<NonNullable<ChatSessionsStoreDeps['listChats']>>()
			.mockReturnValueOnce(pending.promise);
		const store = new ChatSessionsStore({ listChats });

		const refreshing = store.refreshChats();
		store.patchChat('removed', { activityStatus: 'error' });
		store.removeChat('removed');
		pending.resolve(response(entry('removed', 'complete')));
		await refreshing;

		expect(listChats).toHaveBeenCalledOnce();
		expect(store.byId.removed).toBeUndefined();
		expect(store.order).not.toContain('removed');
	});

	it('expires activity received during a failed request before the retry', async () => {
		const pending = deferredList();
		const listChats = vi.fn<NonNullable<ChatSessionsStoreDeps['listChats']>>()
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValueOnce(response(entry('first', 'complete')));
		const store = new ChatSessionsStore({ listChats });
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const refreshing = store.refreshChats();
			store.patchChat('first', { activityStatus: 'error' });
			pending.reject(new Error('Synthetic request failure'));
			await refreshing;
			expect(store.chatListStatus).toBe('error');

			await store.refreshChats();
			expect(listChats).toHaveBeenCalledTimes(2);
			expect(store.chatListStatus).toBe('ready');
			expect(store.byId.first.activityStatus).toBe('complete');
		} finally {
			logged.mockRestore();
		}
	});
});
