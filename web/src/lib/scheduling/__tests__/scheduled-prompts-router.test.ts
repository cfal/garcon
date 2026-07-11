import { describe, expect, it, vi } from 'vitest';
import { ScheduledPromptsRouter } from '../scheduled-prompts-router.svelte';
import type { DrainCursor, WsConnection } from '$lib/ws/connection.svelte';

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

describe('ScheduledPromptsRouter', () => {
	it('refreshes loaded scheduling state for typed invalidations only', () => {
		const prompts = { refreshIfLoaded: vi.fn() };
		const router = new ScheduledPromptsRouter(
			connection([
				{ type: 'chat-processing-updated', chatId: '123', isProcessing: true },
				{ type: 'scheduled-prompts-invalidated', reason: 'executed' },
			]),
			prompts as never,
		);
		router.start();
		router.tick();

		expect(prompts.refreshIfLoaded).toHaveBeenCalledTimes(1);
		router.tick();
		expect(prompts.refreshIfLoaded).toHaveBeenCalledTimes(1);
		router.destroy();
	});
});
