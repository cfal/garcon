import { describe, expect, it, vi } from 'vitest';
import { QueueDispatchingMessage, QueueStateUpdatedMessage } from '$shared/ws-events';
import { handleQueueSending, handleQueueUpdated, type QueueContext } from '../handlers/queue';

function makeQueueContext(overrides: Partial<QueueContext> = {}): {
	ctx: QueueContext;
	setMessageQueue: ReturnType<typeof vi.fn>;
	activateLoadingFor: ReturnType<typeof vi.fn>;
} {
	const setMessageQueue = vi.fn();
	const activateLoadingFor = vi.fn();
	const ctx: QueueContext = {
		getCurrentChatId: () => 'chat-a',
		getSelectedChatId: () => 'chat-a',
		conversationUi: { setMessageQueue },
		activateLoadingFor,
		setCanAbort: vi.fn(),
		onChatProcessing: vi.fn(),
		...overrides,
	};
	return { ctx, setMessageQueue, activateLoadingFor };
}

describe('queue handler', () => {
	it('caches queue updates by chat id regardless of selection', () => {
		const { ctx, setMessageQueue } = makeQueueContext({
			getCurrentChatId: () => 'chat-a',
			getSelectedChatId: () => 'chat-a',
		});
		const queueState = { entries: [], paused: false };

		handleQueueUpdated(new QueueStateUpdatedMessage('chat-b', queueState), ctx);

		expect(setMessageQueue).toHaveBeenCalledWith('chat-b', queueState);
	});

	it('activates loading only for current or selected chat', () => {
		const { ctx, activateLoadingFor } = makeQueueContext({
			getCurrentChatId: () => 'chat-a',
			getSelectedChatId: () => 'chat-a',
		});

		handleQueueSending(new QueueDispatchingMessage('chat-b', 'q1', 'queued text'), ctx);
		expect(activateLoadingFor).not.toHaveBeenCalled();

		handleQueueSending(new QueueDispatchingMessage('chat-a', 'q2', 'queued text'), ctx);
		expect(activateLoadingFor).toHaveBeenCalledTimes(1);
	});
});
