import { describe, expect, it, vi } from 'vitest';
import { IssuesInvalidationHub } from '$lib/issues/catalog/issues-invalidation-hub';
import { WsConnection } from '$lib/ws/connection.svelte';
import { IssuesRouter } from '../issues-router.svelte';

describe('Issues invalidation routing', () => {
	it('filters invalid messages, drains once, propagates reconnect and cleans subscriptions', () => {
		const connection = new WsConnection();
		const hub = new IssuesInvalidationHub();
		const received = vi.fn();
		const unsubscribe = hub.subscribe(received);
		const router = new IssuesRouter(connection, hub);
		router.start();
		router.start();
		connection.messages.push(...[
			{ type: 'issues-invalidated', revision: 3 },
			{ type: 'issues-invalidated', revision: -1 },
			{ type: 'issues-invalidated', revision: 4, content: 'Invalid extra field' },
			{ type: 'chat-boards-invalidated', revision: 1, reason: 'created' },
		].map((data) => ({ data, timestamp: 0 })));
		router.tick();
		router.tick();
		expect(received).toHaveBeenCalledExactlyOnceWith({ kind: 'collection', revision: 3 });
		hub.publishReconnect();
		expect(received).toHaveBeenLastCalledWith({ kind: 'reconnect' });
		router.destroy();
		connection.messages.push({ data: { type: 'issues-invalidated', revision: 5 }, timestamp: 0 });
		router.tick();
		expect(received).toHaveBeenCalledTimes(2);
		unsubscribe();
		hub.publishReconnect();
		expect(received).toHaveBeenCalledTimes(2);
		connection.disconnect();
	});
});
