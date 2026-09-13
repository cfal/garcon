import { describe, expect, it, vi } from 'vitest';
import { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub';
import { WsConnection } from '$lib/ws/connection.svelte';
import { TicketsRouter } from '../tickets-router.svelte';

describe('Tickets invalidation routing', () => {
	it('filters invalid messages, drains once, propagates reconnect and cleans subscriptions', () => {
		const connection = new WsConnection();
		const hub = new TicketsInvalidationHub();
		const received = vi.fn();
		const unsubscribe = hub.subscribe(received);
		const router = new TicketsRouter(connection, hub);
		router.start();
		router.start();
		connection.messages.push(...[
			{ type: 'tickets-invalidated', revision: 3 },
			{ type: 'tickets-invalidated', revision: -1 },
			{ type: 'tickets-invalidated', revision: 4, content: 'Invalid extra field' },
			{ type: 'chat-boards-invalidated', revision: 1, reason: 'created' },
		].map((data) => ({ data, timestamp: 0 })));
		router.tick();
		router.tick();
		expect(received).toHaveBeenCalledExactlyOnceWith({ kind: 'collection', revision: 3 });
		hub.publishReconnect();
		expect(received).toHaveBeenLastCalledWith({ kind: 'reconnect' });
		router.destroy();
		connection.messages.push({ data: { type: 'tickets-invalidated', revision: 5 }, timestamp: 0 });
		router.tick();
		expect(received).toHaveBeenCalledTimes(2);
		unsubscribe();
		hub.publishReconnect();
		expect(received).toHaveBeenCalledTimes(2);
		connection.disconnect();
	});
});
