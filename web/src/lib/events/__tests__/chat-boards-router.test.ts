import { describe, expect, it, vi } from 'vitest';
import { WsConnection, type DrainCursor } from '$lib/ws/connection.svelte';
import { createDrainCursor } from '$lib/ws/drain';
import type { WsMessageLog } from '$lib/ws/drain';
import { ChatBoardInvalidationHub } from '$lib/chat-board/catalog/chat-board-invalidation-hub';
import { ChatBoardsRouter } from '../chat-boards-router';

function connection(messages: Array<Record<string, unknown>>): WsMessageLog {
	return {
		messages: messages.map((data) => ({ data, timestamp: Date.now() })),
		trimOffset: 0,
		trimConsumedMessages: () => {},
		registerCursor(cursor: DrainCursor) {
			cursor.current = 0;
			return vi.fn();
		},
	} satisfies WsMessageLog;
}

describe('ChatBoardsRouter', () => {
	it('routes filtered events before releasing a shared connection log', () => {
		const ws = new WsConnection();
		const hub = new ChatBoardInvalidationHub();
		const listener = vi.fn();
		hub.subscribe(listener);
		const router = new ChatBoardsRouter(ws, hub);
		router.start();
		const otherReader = createDrainCursor(ws);
		ws.messages.push(
			{ data: { type: 'chat-processing-updated', chatId: 'synthetic' }, timestamp: 0 },
			{ data: { type: 'chat-boards-invalidated', revision: 7, reason: 'reordered' }, timestamp: 0 },
		);
		router.tick();
		expect(listener).toHaveBeenCalledOnce();
		expect(ws.messages).toHaveLength(2);
		expect(otherReader.drain()).toHaveLength(2);
		expect(ws.messages).toEqual([]);
		router.tick();
		expect(listener).toHaveBeenCalledOnce();
		otherReader.cleanup();
		router.destroy();
		ws.disconnect();
	});

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
