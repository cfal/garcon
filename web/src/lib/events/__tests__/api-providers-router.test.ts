import { describe, expect, it, vi } from 'vitest';
import { WsConnection } from '$lib/ws/connection.svelte';
import { ApiProvidersRouter } from '../api-providers-router.svelte';
import { ApiProvidersInvalidatedMessage, parseServerWsMessage } from '$shared/ws-events';

describe('ApiProvidersRouter', () => {
	it('round-trips the typed event and invalidates each browser once through its own cursor', () => {
		const ws = new WsConnection();
		const invalidate = vi.fn();
		const unregister = vi.fn();
		vi.spyOn(ws, 'registerCursor').mockReturnValue(unregister);
		const event = JSON.parse(JSON.stringify(new ApiProvidersInvalidatedMessage()));
		expect(parseServerWsMessage(event)).toBeInstanceOf(ApiProvidersInvalidatedMessage);
		vi.spyOn(ws, 'messages', 'get').mockReturnValue([
			{ data: event, timestamp: 1 },
			{ data: { type: 'settings-changed' }, timestamp: 2 },
		]);
		const router = new ApiProvidersRouter(ws, { invalidate });
		try {
			router.start(); router.start(); router.tick(); router.tick();
			expect(invalidate).toHaveBeenCalledOnce();
		} finally { router.destroy(); ws.disconnect(); }
		expect(unregister).toHaveBeenCalledOnce();
	});
});
