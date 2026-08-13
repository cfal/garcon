import { describe, expect, it, vi } from 'vitest';
import { ChatExecutionControlUpdatedMessage } from '$shared/ws-events';
import type { ChatExecutionControlState } from '$lib/types/chat';
import { filterByChat } from '../chat-filter';
import { handleExecutionControlUpdated, type QueueContext } from '../handlers/queue';

function makeContext(
	setExecutionControlFromLiveUpdate: (chatId: string, control: ChatExecutionControlState) => boolean,
): QueueContext {
	return {
		conversationUi: { setExecutionControlFromLiveUpdate },
	};
}

describe('queue routing integration', () => {
	it('applies execution-control updates for background chats through filter + handler path', () => {
		const setExecutionControlFromLiveUpdate = vi.fn(() => true);
		const control = {
			serverInstanceId: 'server-instance-test',
			queue: {
				entries: [],
				steeringEntryId: null,
				recentlyDispatched: [],
				pause: null,
				reorderRevision: 0,
			},
			version: 3,
			updatedAt: '2026-07-16T00:00:00.000Z',
		};
		const message = new ChatExecutionControlUpdatedMessage('chat-b', control);
		const filterResult = filterByChat(message.type, message, {
			selectedChatId: 'chat-a',
			currentChatId: 'chat-a',
			pendingViewChatId: null,
		});

		if (filterResult.action === 'process') {
			handleExecutionControlUpdated(message, makeContext(setExecutionControlFromLiveUpdate));
		}

		expect(filterResult).toEqual({ action: 'process' });
		expect(setExecutionControlFromLiveUpdate).toHaveBeenCalledWith('chat-b', control);
	});
});
