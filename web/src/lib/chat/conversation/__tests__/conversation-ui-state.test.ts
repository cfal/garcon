import { describe, expect, it } from 'vitest';
import { ConversationUiState } from '../conversation-ui-state.svelte.js';
import type { PendingPermissionRequest, QueueState } from '$lib/types/chat';
import { BashToolUseMessage } from '$shared/chat-types';

function makeQueue(overrides: Partial<QueueState> = {}): QueueState {
	return {
		entries: [],
		dispatchingEntryId: null,
		recentlyDispatched: [],
		paused: false,
		version: 0,
		updatedAt: null,
		...overrides,
	};
}

function makeEntry(id: string, content: string, revision = 1) {
	return {
		id,
		content,
		revision,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
}

function makePermissionRequest(id: string, chatId: string | null = null): PendingPermissionRequest {
	return {
		permissionRequestId: id,
		requestedTool: new BashToolUseMessage('2026-07-15T00:00:00.000Z', `tool-${id}`, 'echo test'),
		chatId,
	};
}

describe('ConversationUiState', () => {
	it('updates pending permission requests through values or updater functions', () => {
		const store = new ConversationUiState();
		const first = makePermissionRequest('one');

		store.setPendingPermissionRequests([first]);
		store.setPendingPermissionRequests((previous) => [
			...previous,
			makePermissionRequest('two', 'chat-1'),
		]);

		expect(store.pendingPermissionRequests.map((request) => request.permissionRequestId)).toEqual([
			'one',
			'two',
		]);

		store.clearPendingPermissionRequests();

		expect(store.pendingPermissionRequests).toEqual([]);
	});

	it('stores queues by chat and prunes queues for removed chats', () => {
		const store = new ConversationUiState();
		const queue = makeQueue();

		store.setMessageQueue('chat-a', queue);
		store.setMessageQueue('chat-b', null);
		store.pruneQueues(new Set(['chat-a']));

		expect(store.getQueue('chat-a')).toEqual(queue);
		expect(store.getQueue('chat-b')).toBeNull();
		expect(store.queueChatIds).toEqual(['chat-a']);
	});

	it('does not let refresh responses overwrite same-version live queue state', () => {
		const store = new ConversationUiState();
		const live = makeQueue({ entries: [makeEntry('entry-live', 'live')], version: 4 });
		const staleRefresh = makeQueue({
			entries: [makeEntry('entry-refresh', 'stale')],
			paused: true,
			version: 4,
		});

		store.setMessageQueue('chat-a', live);
		store.setMessageQueueFromRefresh('chat-a', staleRefresh);

		expect(store.getQueue('chat-a')).toEqual(live);
	});
});
