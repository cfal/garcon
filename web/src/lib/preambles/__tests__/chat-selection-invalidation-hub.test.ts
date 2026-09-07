import { describe, expect, it, vi } from 'vitest';
import { createChatPreambleSelectionInvalidationHub } from '$lib/preambles/chat-selection-invalidation-hub.js';

describe('ChatPreambleSelectionInvalidationHub', () => {
	it('dispatches to a snapshot so a resubscribing listener is not revisited', () => {
		const hub = createChatPreambleSelectionInvalidationHub();
		const calls: string[] = [];
		let subscribeCount = 0;

		const subscribe = () => {
			subscribeCount += 1;
			const label = `listener-${subscribeCount}`;
			hub.subscribe((event) => {
				if (event.kind !== 'selection') return;
				calls.push(`${label}:${event.revision}`);
				if (label === 'listener-1') {
					// A clean editor refresh: unsubscribe and resubscribe
					// synchronously while the dispatch is running.
					hub.subscribe((next) => {
						if (next.kind === 'selection') calls.push(`listener-2:${next.revision}`);
					});
				}
			});
		};
		subscribe();

		hub.publish({ kind: 'selection', chatId: 'chat-1', revision: 1 });
		// Only the original listener observes this dispatch; the replacement
		// waits for the next event instead of being visited in the same loop.
		expect(calls).toEqual(['listener-1:1']);

		hub.publish({ kind: 'selection', chatId: 'chat-1', revision: 2 });
		expect(calls).toEqual(['listener-1:1', 'listener-1:2', 'listener-2:2']);
	});

	it('supports external observers alongside editors', () => {
		const hub = createChatPreambleSelectionInvalidationHub();
		const external = vi.fn();
		hub.subscribe(external);
		hub.publish({ kind: 'selection', chatId: 'chat-2', revision: 5 });
		expect(external).toHaveBeenCalledWith({
			kind: 'selection',
			chatId: 'chat-2',
			revision: 5,
		});
	});

	it('publishes reconnect as an explicit event without a fake chat ID', () => {
		const hub = createChatPreambleSelectionInvalidationHub();
		const listener = vi.fn();
		hub.subscribe(listener);
		hub.publishReconnect();
		expect(listener).toHaveBeenCalledWith({ kind: 'reconnect' });
	});
});
