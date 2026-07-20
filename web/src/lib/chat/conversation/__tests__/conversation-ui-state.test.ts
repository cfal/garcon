import { describe, expect, it } from 'vitest';
import { ConversationUiState } from '../conversation-ui-state.svelte.js';
import type {
	ChatExecutionControlState,
	ChatQueueState,
	PendingPermissionRequest,
} from '$lib/types/chat';
import { BashToolUseMessage } from '$shared/chat-types';

function makeQueue(overrides: Partial<ChatQueueState> = {}): ChatQueueState {
	return {
		entries: [],
		dispatchingEntryId: null,
		recentlyDispatched: [],
		pause: null,
		...overrides,
	};
}

function makeControl(
	queue: ChatQueueState = makeQueue(),
	overrides: Partial<ChatExecutionControlState> = {},
): ChatExecutionControlState {
	return {
		queue,
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

	it('stores execution controls by chat and prunes controls for removed chats', () => {
		const store = new ConversationUiState();
		const control = makeControl();

		store.setExecutionControl('chat-a', control);
		store.setExecutionControl('chat-b', null);
		store.pruneExecutionControls(new Set(['chat-a']));

		expect(store.getExecutionControl('chat-a')).toEqual(control);
		expect(store.getExecutionControl('chat-b')).toBeNull();
		expect(store.executionControlChatIds).toEqual(['chat-a']);
	});

	it('does not let refresh responses overwrite same-version live execution-control state', () => {
		const store = new ConversationUiState();
		const live = makeControl(makeQueue({ entries: [makeEntry('entry-live', 'live')] }), {
			version: 4,
		});
		const staleRefresh = makeControl(
			makeQueue({
				entries: [makeEntry('entry-refresh', 'stale')],
				pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-01-01T00:00:00.000Z' },
			}),
			{ version: 4 },
		);

		store.setExecutionControl('chat-a', live);
		store.setExecutionControlFromRefresh('chat-a', staleRefresh);

		expect(store.getExecutionControl('chat-a')).toEqual(live);
	});
});
