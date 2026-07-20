import { describe, expect, it, vi } from 'vitest';
import { ChatExecutionControlUpdatedMessage } from '$shared/ws-events';
import type { ChatExecutionControlState } from '$lib/types/chat';
import { filterByChat } from '../chat-filter';
import { handleExecutionControlUpdated, type QueueContext } from '../handlers/queue';

function makeContext(
	setExecutionControl: (chatId: string, control: ChatExecutionControlState | null) => void,
): QueueContext {
	return {
		getCurrentChatId: () => 'chat-a',
		getSelectedChatId: () => 'chat-a',
		conversationUi: { setExecutionControl },
		markTurnRunning: vi.fn(),
		onChatProcessing: vi.fn(),
	};
}

describe('queue routing integration', () => {
	it('applies execution-control updates for background chats through filter + handler path', () => {
		const setExecutionControl = vi.fn();
		const control = {
			queue: { entries: [], dispatchingEntryId: null, recentlyDispatched: [], pause: null },
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
			handleExecutionControlUpdated(message, makeContext(setExecutionControl));
		}

		expect(filterResult).toEqual({ action: 'process' });
		expect(setExecutionControl).toHaveBeenCalledWith('chat-b', control);
	});
});
