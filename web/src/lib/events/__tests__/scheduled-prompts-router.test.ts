import { describe, expect, it, vi } from 'vitest';
import { ScheduledPromptsRouter } from '../scheduled-prompts-router';
import type { DrainCursor } from '$lib/ws/connection.svelte';

import type { WsMessageLog } from '$lib/ws/drain';

function connection(messages: Array<Record<string, unknown>>): WsMessageLog {
	return {
		messages: messages.map((data) => ({ data, timestamp: Date.now() })),
		trimOffset: 0,
		registerCursor(cursor: DrainCursor) {
			cursor.current = 0;
			return vi.fn();
		},
	} satisfies WsMessageLog;
}

describe('ScheduledPromptsRouter', () => {
	it('refreshes loaded scheduling state for typed invalidations only', () => {
		const prompts = { refreshIfLoaded: vi.fn() };
		const router = new ScheduledPromptsRouter(
			connection([
				{ type: 'chat-processing-updated', chatId: '123', isProcessing: true },
				{ type: 'scheduled-prompts-invalidated', reason: 'executed' },
			]),
			prompts,
		);
		router.start();
		router.tick();

		expect(prompts.refreshIfLoaded).toHaveBeenCalledTimes(1);
		router.tick();
		expect(prompts.refreshIfLoaded).toHaveBeenCalledTimes(1);
		router.destroy();
	});
});
