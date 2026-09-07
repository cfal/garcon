import { describe, expect, it, vi } from 'vitest';
import { ChatBoardInvalidationHub } from '../catalog/chat-board-invalidation-hub';

describe('ChatBoardInvalidationHub', () => {
	it('publishes typed catalog and reconnect events and supports cleanup', () => {
		const hub = new ChatBoardInvalidationHub();
		const listener = vi.fn();
		const unsubscribe = hub.subscribe(listener);
		hub.publish({ kind: 'catalog', revision: 3, reason: 'updated' });
		hub.publishReconnect();
		unsubscribe();
		hub.publishReconnect();

		expect(listener.mock.calls.map(([event]) => event)).toEqual([
			{ kind: 'catalog', revision: 3, reason: 'updated' },
			{ kind: 'reconnect' },
		]);
	});
});
