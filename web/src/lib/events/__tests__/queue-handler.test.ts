import { describe, expect, it, vi } from 'vitest';
import { ChatExecutionControlUpdatedMessage, QueueDispatchingMessage } from '$shared/ws-events';
import {
	handleExecutionControlUpdated,
	handleQueueSending,
	type QueueContext,
} from '../handlers/queue';

function makeQueueContext(overrides: Partial<QueueContext> = {}): {
	ctx: QueueContext;
	setExecutionControl: ReturnType<typeof vi.fn>;
	markTurnRunning: ReturnType<typeof vi.fn>;
} {
	const setExecutionControl = vi.fn();
	const markTurnRunning = vi.fn();
	const ctx: QueueContext = {
		getCurrentChatId: () => 'chat-a',
		getSelectedChatId: () => 'chat-a',
		conversationUi: { setExecutionControl },
		markTurnRunning,
		onChatProcessing: vi.fn(),
		...overrides,
	};
	return { ctx, setExecutionControl, markTurnRunning };
}

describe('queue handler', () => {
	it('caches execution-control updates by chat id regardless of selection', () => {
		const { ctx, setExecutionControl } = makeQueueContext({
			getCurrentChatId: () => 'chat-a',
			getSelectedChatId: () => 'chat-a',
		});
		const control = {
			queue: { entries: [], dispatchingEntryId: null, recentlyDispatched: [], pause: null },
			recoveredInputContinuation: null,
			version: 2,
			updatedAt: '2026-07-16T00:00:00.000Z',
		};

		handleExecutionControlUpdated(new ChatExecutionControlUpdatedMessage('chat-b', control), ctx);

		expect(setExecutionControl).toHaveBeenCalledWith('chat-b', control);
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
