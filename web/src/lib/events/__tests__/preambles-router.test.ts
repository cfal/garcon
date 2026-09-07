import { describe, expect, it, vi } from 'vitest';
import { PreamblesRouter } from '../preambles-router.svelte';
import type { DrainCursor, WsConnection } from '$lib/ws/connection.svelte';
import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte';

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

describe('PreamblesRouter', () => {
	it('refreshes loaded catalog state for typed invalidations only', () => {
		const preambles = {
			refreshIfLoaded: vi.fn(),
		} satisfies Pick<PreamblesStore, 'refreshIfLoaded'>;
		const router = new PreamblesRouter(
			connection([
				{ type: 'chat-processing-updated', chatId: '123', isProcessing: true },
				{ type: 'preambles-invalidated', reason: 'reordered' },
			]),
			preambles,
		);
		router.start();
		router.tick();

		expect(preambles.refreshIfLoaded).toHaveBeenCalledOnce();
		router.tick();
		expect(preambles.refreshIfLoaded).toHaveBeenCalledOnce();
		router.destroy();
	});
});
