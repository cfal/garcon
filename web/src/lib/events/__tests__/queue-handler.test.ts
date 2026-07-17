import { describe, expect, it, vi } from 'vitest';
import { QueueDispatchingMessage, QueueStateUpdatedMessage } from '$shared/ws-events';
import { handleQueueSending, handleQueueUpdated, type QueueContext } from '../handlers/queue';

function makeQueueContext(overrides: Partial<QueueContext> = {}): {
	ctx: QueueContext;
	setMessageQueue: ReturnType<typeof vi.fn>;
	markTurnRunning: ReturnType<typeof vi.fn>;
} {
	const setMessageQueue = vi.fn();
	const markTurnRunning = vi.fn();
	const ctx: QueueContext = {
		getCurrentChatId: () => 'chat-a',
		getSelectedChatId: () => 'chat-a',
		conversationUi: { setMessageQueue },
		markTurnRunning,
		onChatProcessing: vi.fn(),
		...overrides,
	};
	return { ctx, setMessageQueue, markTurnRunning };
}

describe('queue handler', () => {
	it('caches queue updates by chat id regardless of selection', () => {
		const { ctx, setMessageQueue } = makeQueueContext({
			getCurrentChatId: () => 'chat-a',
			getSelectedChatId: () => 'chat-a',
		});
		const queueState = {
			entries: [],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: null,
			version: 2,
			updatedAt: '2026-07-16T00:00:00.000Z',
		};

		handleQueueUpdated(new QueueStateUpdatedMessage('chat-b', queueState), ctx);

		expect(setMessageQueue).toHaveBeenCalledWith('chat-b', queueState);
	});

	it('marks the selected turn running only for current or selected chat', () => {
		const { ctx, markTurnRunning } = makeQueueContext({
			getCurrentChatId: () => 'chat-a',
			getSelectedChatId: () => 'chat-a',
		});

		handleQueueSending(new QueueDispatchingMessage('chat-b', 'q1', 'queued text'), ctx);
		expect(markTurnRunning).not.toHaveBeenCalled();

		handleQueueSending(new QueueDispatchingMessage('chat-a', 'q2', 'queued text'), ctx);
		expect(markTurnRunning).toHaveBeenCalledTimes(1);
		expect(markTurnRunning).toHaveBeenCalledWith('chat-a');
	});
});
