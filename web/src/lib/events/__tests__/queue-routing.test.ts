import { describe, expect, it, vi } from 'vitest';
import { QueueStateUpdatedMessage } from '$shared/ws-events';
import type { QueueState } from '$lib/types/chat';
import { filterByChat } from '../chat-filter';
import { handleQueueUpdated, type QueueContext } from '../handlers/queue';

function makeContext(
	setMessageQueue: (chatId: string, queue: QueueState | null) => void,
): QueueContext {
	return {
		getCurrentChatId: () => 'chat-a',
		getSelectedChatId: () => 'chat-a',
		conversationUi: { setMessageQueue },
		markTurnRunning: vi.fn(),
		onChatProcessing: vi.fn(),
	};
}

describe('queue routing integration', () => {
	it('applies queue updates for background chats through filter + handler path', () => {
		const setMessageQueue = vi.fn();
		const queue = {
			entries: [],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			paused: false,
			version: 3,
			updatedAt: '2026-07-16T00:00:00.000Z',
		};
		const message = new QueueStateUpdatedMessage('chat-b', queue);
		const filterResult = filterByChat(message.type, message, {
			selectedChatId: 'chat-a',
			currentChatId: 'chat-a',
			pendingViewChatId: null,
		});

		if (filterResult.action === 'process') {
			handleQueueUpdated(message, makeContext(setMessageQueue));
		}

		expect(filterResult).toEqual({ action: 'process' });
		expect(setMessageQueue).toHaveBeenCalledWith('chat-b', queue);
	});
});
