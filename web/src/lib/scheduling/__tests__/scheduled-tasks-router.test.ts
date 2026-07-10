import { describe, expect, it, vi } from 'vitest';
import { ScheduledTasksRouter } from '../scheduled-tasks-router.svelte';
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

describe('ScheduledTasksRouter', () => {
	it('refreshes loaded scheduling state for typed invalidations only', () => {
		const tasks = { refreshIfLoaded: vi.fn() };
		const router = new ScheduledTasksRouter(
			connection([
				{ type: 'chat-processing-updated', chatId: '123', isProcessing: true },
				{ type: 'scheduled-tasks-invalidated', reason: 'executed' },
			]),
			tasks as never,
		);
		router.start();
		router.tick();

		expect(tasks.refreshIfLoaded).toHaveBeenCalledTimes(1);
		router.tick();
		expect(tasks.refreshIfLoaded).toHaveBeenCalledTimes(1);
		router.destroy();
	});
});
