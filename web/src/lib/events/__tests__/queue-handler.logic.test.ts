import { describe, expect, it, vi } from 'vitest';
import { ChatExecutionControlUpdatedMessage } from '$shared/ws-events';
import {
	handleExecutionControlUpdated,
	type QueueContext,
} from '../handlers/queue';

function makeQueueContext(overrides: Partial<QueueContext> = {}): {
	ctx: QueueContext;
	setExecutionControlFromLiveUpdate: ReturnType<typeof vi.fn>;
} {
	const setExecutionControlFromLiveUpdate = vi.fn();
	const ctx: QueueContext = {
		conversationUi: { setExecutionControlFromLiveUpdate },
		...overrides,
	};
	return { ctx, setExecutionControlFromLiveUpdate };
}

describe('queue handler', () => {
	it('caches execution-control updates by chat id regardless of selection', () => {
		const { ctx, setExecutionControlFromLiveUpdate } = makeQueueContext();
		const control = {
			serverInstanceId: 'server-instance-test',
			queue: {
				entries: [],
				steeringEntryId: null,
				recentlyDispatched: [],
				pause: null,
				reorderRevision: 0,
			},
			version: 2,
			updatedAt: '2026-07-16T00:00:00.000Z',
		};

		handleExecutionControlUpdated(new ChatExecutionControlUpdatedMessage('chat-b', control), ctx);

		expect(setExecutionControlFromLiveUpdate).toHaveBeenCalledWith('chat-b', control);
	});
});
