import { describe, expect, it, vi } from 'vitest';
import { WsConnection } from '$lib/ws/connection.svelte';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte';
import { localExecutionNode, remoteExecutionNode } from '$lib/execution-nodes/__tests__/fixtures';
import { ExecutionNodesRouter } from '../execution-nodes-router.svelte';

describe('ExecutionNodesRouter', () => {
	it('delivers only valid snapshots, drains once, and unregisters on teardown', () => {
		const ws = new WsConnection();
		const nodes = new ExecutionNodesStore();
		const apply = vi.spyOn(nodes, 'applySnapshot');
		const unregister = vi.fn();
		vi.spyOn(ws, 'registerCursor').mockReturnValue(unregister);
		vi.spyOn(ws, 'messages', 'get').mockReturnValue([
			{ data: { type: 'execution-nodes-changed', nodes: [localExecutionNode, remoteExecutionNode] }, timestamp: 1 },
			{ data: { type: 'execution-nodes-changed', nodes: [{ ...remoteExecutionNode, secret: 'private' }] }, timestamp: 2 },
			{ data: { type: 'snippets-invalidated', reason: 'updated' }, timestamp: 3 },
		]);
		const router = new ExecutionNodesRouter(ws, nodes);
		try {
			router.start();
			router.start();
			router.tick();
			router.tick();
			expect(apply).toHaveBeenCalledTimes(1);
			expect(nodes.nodes).toEqual([localExecutionNode, remoteExecutionNode]);
		} finally {
			router.destroy();
			ws.disconnect();
		}
		expect(unregister).toHaveBeenCalledTimes(1);
	});
});
