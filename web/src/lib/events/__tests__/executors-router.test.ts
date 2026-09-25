import { describe, expect, it, vi } from 'vitest';
import { WsConnection } from '$lib/ws/connection.svelte';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { ExecutorsRouter } from '../executors-router.svelte.ts';

describe('ExecutorsRouter', () => {
	it('delivers only valid snapshots, drains once, and unregisters on teardown', () => {
		const ws = new WsConnection();
		const executors = new ExecutorsStore();
		const apply = vi.spyOn(executors, 'applySnapshot');
		const unregister = vi.fn();
		vi.spyOn(ws, 'registerCursor').mockReturnValue(unregister);
		vi.spyOn(ws, 'messages', 'get').mockReturnValue([
			{ data: { type: 'executors-changed', executors: [localExecutor, remoteExecutor] }, timestamp: 1 },
			{ data: { type: 'executors-changed', executors: [{ ...remoteExecutor, secret: 'private' }] }, timestamp: 2 },
			{ data: { type: 'snippets-invalidated', reason: 'updated' }, timestamp: 3 },
		]);
		const router = new ExecutorsRouter(ws, executors);
		try {
			router.start();
			router.start();
			router.tick();
			router.tick();
			expect(apply).toHaveBeenCalledTimes(1);
			expect(executors.executors).toEqual([localExecutor, remoteExecutor]);
		} finally {
			router.destroy();
			ws.disconnect();
		}
		expect(unregister).toHaveBeenCalledTimes(1);
	});
});
