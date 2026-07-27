import { describe, expect, it, vi } from 'vitest';
import { ChatExecutionControlUpdatedMessage } from '$shared/ws-events';
import {
	handleExecutionControlUpdated,
	type QueueContext,
} from '../handlers/queue';

function makeQueueContext(overrides: Partial<QueueContext> = {}): {
	ctx: QueueContext;
	setExecutionControl: ReturnType<typeof vi.fn>;
} {
	const setExecutionControl = vi.fn();
	const ctx: QueueContext = {
		conversationUi: { setExecutionControl },
		...overrides,
	};
	return { ctx, setExecutionControl };
}

describe('queue handler', () => {
	it('caches execution-control updates by chat id regardless of selection', () => {
		const { ctx, setExecutionControl } = makeQueueContext();
		const control = {
			queue: {
				entries: [],
				dispatchingEntryId: null,
				recentlyDispatched: [],
				pause: null,
				reorderRevision: 0,
			},
			version: 2,
			updatedAt: '2026-07-16T00:00:00.000Z',
		};

		handleExecutionControlUpdated(new ChatExecutionControlUpdatedMessage('chat-b', control), ctx);

		expect(setExecutionControl).toHaveBeenCalledWith('chat-b', control);
	});
});
