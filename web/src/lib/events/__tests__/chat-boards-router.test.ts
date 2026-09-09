import { describe, expect, it, vi } from 'vitest';
import type { DrainCursor, WsConnection } from '$lib/ws/connection.svelte';
import { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub';
import { ChatBoardsRouter } from '../chat-boards-router.svelte';

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

describe('ChatBoardsRouter', () => {
	it('publishes normalized board invalidations only once', () => {
		const hub = new ChatBoardInvalidationHub();
		const listener = vi.fn();
		hub.subscribe(listener);
		const router = new ChatBoardsRouter(
			connection([
				{ type: 'chat-processing-updated', chatId: 'chat-1', isProcessing: true },
				{ type: 'chat-boards-invalidated', revision: 7, reason: 'reordered' },
			]),
			hub,
		);
		router.start();
		router.tick();
		router.tick();

		expect(listener).toHaveBeenCalledOnce();
		expect(listener).toHaveBeenCalledWith({ kind: 'catalog', revision: 7, reason: 'reordered' });
		router.destroy();
	});
});
