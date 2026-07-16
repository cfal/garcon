import { describe, expect, it, vi } from 'vitest';
import { SnippetsRouter } from '../snippets-router.svelte';
import type { DrainCursor, WsConnection } from '$lib/ws/connection.svelte';
import type { SnippetsStore } from '$lib/snippets/snippets-store.svelte';

function connection(messages: Array<Record<string, unknown>>): WsConnection {
	return {
		messages: messages.map((data) => ({ data, timestamp: Date.now() })),
		trimOffset: 0,
		registerCursor(cursor: DrainCursor) {
			cursor.current = 0;
			return vi.fn();
		},
	} as unknown as WsConnection;
}

describe('SnippetsRouter', () => {
	it('refreshes loaded snippet state for typed invalidations only', () => {
		const snippets = {
			refreshIfLoaded: vi.fn(),
		} satisfies Pick<SnippetsStore, 'refreshIfLoaded'>;
		const router = new SnippetsRouter(
			connection([
				{ type: 'chat-processing-updated', chatId: '123', isProcessing: true },
				{ type: 'snippets-invalidated', reason: 'updated' },
				{ type: 'snippets-invalidated', reason: 'unknown' },
			]),
			snippets,
		);
		router.start();
		router.tick();

		expect(snippets.refreshIfLoaded).toHaveBeenCalledTimes(1);
		router.tick();
		expect(snippets.refreshIfLoaded).toHaveBeenCalledTimes(1);
		router.destroy();
	});
});
