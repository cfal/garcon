import { describe, expect, it } from 'vitest';
import { ConversationUiStore } from '../conversation-ui.svelte';
import type { PendingPermissionRequest } from '$lib/types/chat';

function makePermissionRequest(id: string, chatId: string | null = null): PendingPermissionRequest {
	return {
		permissionRequestId: id,
		requestedTool: { type: 'bash-tool-use', toolId: `tool-${id}` } as never,
		chatId,
	};
}

describe('ConversationUiStore', () => {
	it('updates pending permission requests through values or updater functions', () => {
		const store = new ConversationUiStore();
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
		const store = new ConversationUiStore();
		const queue = { entries: [], paused: false };

		store.setMessageQueue('chat-a', queue);
		store.setMessageQueue('chat-b', null);
		store.pruneQueues(new Set(['chat-a']));

		expect(store.getQueue('chat-a')).toEqual(queue);
		expect(store.getQueue('chat-b')).toBeNull();
		expect(store.queueChatIds).toEqual(['chat-a']);
	});
});
