import { describe, expect, it, vi } from 'vitest';
import { QueueDispatchingMessage, QueueStateUpdatedMessage } from '$shared/ws-events';
import { handleQueueSending, handleQueueUpdated, type QueueContext } from '../handlers/queue';

function makeQueueContext(overrides: Partial<QueueContext> = {}): {
	ctx: QueueContext;
	setMessageQueue: ReturnType<typeof vi.fn>;
	setChatMessages: ReturnType<typeof vi.fn>;
} {
	const setMessageQueue = vi.fn();
	const setChatMessages = vi.fn();
	const ctx: QueueContext = {
		currentChatId: 'chat-a',
		selectedChatId: 'chat-a',
		setChatMessages,
		setMessageQueue,
		activateLoadingFor: vi.fn(),
		setCanAbort: vi.fn(),
		onChatProcessing: vi.fn(),
		...overrides,
	};
	return { ctx, setMessageQueue, setChatMessages };
}

describe('queue handler', () => {
	it('caches queue updates by chat id regardless of selection', () => {
		const { ctx, setMessageQueue } = makeQueueContext({
			currentChatId: 'chat-a',
			selectedChatId: 'chat-a',
		});
		const queueState = { entries: [], paused: false };

		handleQueueUpdated(new QueueStateUpdatedMessage('chat-b', queueState), ctx);

		expect(setMessageQueue).toHaveBeenCalledWith('chat-b', queueState);
	});

	it('appends queued message only for current or selected chat', () => {
		const { ctx, setChatMessages } = makeQueueContext({
			currentChatId: 'chat-a',
			selectedChatId: 'chat-a',
		});

		handleQueueSending(new QueueDispatchingMessage('chat-b', 'q1', 'queued text'), ctx);
		expect(setChatMessages).not.toHaveBeenCalled();

		handleQueueSending(new QueueDispatchingMessage('chat-a', 'q2', 'queued text'), ctx);
		expect(setChatMessages).toHaveBeenCalledTimes(1);
	});
});
