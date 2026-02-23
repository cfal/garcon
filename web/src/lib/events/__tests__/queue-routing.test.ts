import { describe, expect, it, vi } from 'vitest';
import { QueueStateUpdatedMessage } from '$shared/ws-events';
import type { QueueState } from '$lib/types/chat';
import { filterByChat } from '../chat-filter';
import { handleQueueUpdated, type QueueContext } from '../handlers/queue';

function makeContext(setMessageQueue: (chatId: string, queue: QueueState | null) => void): QueueContext {
	return {
		currentChatId: 'chat-a',
		selectedChatId: 'chat-a',
		setChatMessages: vi.fn(),
		setMessageQueue,
		activateLoadingFor: vi.fn(),
		setCanAbort: vi.fn(),
		onChatProcessing: vi.fn(),
	};
}

describe('queue routing integration', () => {
	it('applies queue updates for background chats through filter + handler path', () => {
		const setMessageQueue = vi.fn();
		const message = new QueueStateUpdatedMessage('chat-b', { entries: [], paused: false });
		const filterResult = filterByChat(message.type, message, {
			selectedChatId: 'chat-a',
			currentChatId: 'chat-a',
			pendingViewChatId: null,
		});

		if (filterResult.action === 'process') {
			handleQueueUpdated(message, makeContext(setMessageQueue));
		}

		expect(filterResult).toEqual({ action: 'process' });
		expect(setMessageQueue).toHaveBeenCalledWith('chat-b', { entries: [], paused: false });
	});
});
