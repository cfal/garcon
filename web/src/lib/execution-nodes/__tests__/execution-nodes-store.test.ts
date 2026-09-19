import { describe, expect, it, vi } from 'vitest';
import type { ExecutionNodeSnapshot } from '$shared/execution-nodes';
import { ExecutionNodesStore, executionNodeStatus } from '../execution-nodes-store.svelte';
import { localExecutionNode, remoteExecutionNode } from './fixtures';

describe('ExecutionNodesStore', () => {
	it('keeps Local usable before discovery and after an isolated discovery failure', async () => {
		const nodes = new ExecutionNodesStore(async () => { throw new Error('Discovery failed'); });
		expect(nodes.isReady()).toBe(true);
		expect(nodes.isReady(remoteExecutionNode.id)).toBe(false);
		expect(nodes.nodes.map((node) => node.id)).toEqual(['local']);
		expect(nodes.hasSnapshot).toBe(false);
		await nodes.refresh();
		expect(nodes.error).toBe('Discovery failed');
		expect(nodes.isReady('local')).toBe(true);
		nodes.applySnapshot([{ ...localExecutionNode, availability: 'offline' }]);
		expect(nodes.hasSnapshot).toBe(true);
		expect(nodes.isReady('local')).toBe(false);
	});

	it('keeps unknown targets unavailable and removes deleted nodes', () => {
		const nodes = new ExecutionNodesStore();
		nodes.applySnapshot([localExecutionNode, remoteExecutionNode]);
		expect(nodes.isReady()).toBe(true);
		expect(nodes.isReady(remoteExecutionNode.id)).toBe(true);
		nodes.applySnapshot([localExecutionNode]);
		expect(nodes.get(remoteExecutionNode.id)).toBeUndefined();
		expect(nodes.isReady(remoteExecutionNode.id)).toBe(false);
		expect(nodes.label(remoteExecutionNode.id)).toBe(remoteExecutionNode.id);
	});

	it('rejects credential-bearing snapshots without replacing the current list', () => {
		const nodes = new ExecutionNodesStore();
		nodes.applySnapshot([localExecutionNode]);
		expect(() => nodes.applySnapshot([{ ...remoteExecutionNode, secret: 'private' }])).toThrow();
		expect(() => nodes.applySnapshot([{ ...remoteExecutionNode, connectionUrl: 'private' }])).toThrow();
		expect(nodes.nodes).toEqual([localExecutionNode]);
	});

	it('coalesces refreshes and ignores an HTTP result older than a pushed snapshot', async () => {
		const response = Promise.withResolvers<readonly ExecutionNodeSnapshot[]>();
		const read = vi.fn(() => response.promise);
		const nodes = new ExecutionNodesStore(read);
		const first = nodes.refresh();
		const second = nodes.refresh();
		nodes.applySnapshot([localExecutionNode, remoteExecutionNode]);
		response.resolve([localExecutionNode]);
		await first;
		await second;
		expect(read).toHaveBeenCalledTimes(1);
		expect(nodes.nodes).toEqual([localExecutionNode, remoteExecutionNode]);
		expect(nodes.loading).toBe(false);
	});

	it('preserves pushed readiness when an older HTTP request fails', async () => {
		const response = Promise.withResolvers<readonly ExecutionNodeSnapshot[]>();
		const nodes = new ExecutionNodesStore(() => response.promise);
		const pending = nodes.refresh();
		nodes.applySnapshot([remoteExecutionNode]);
		response.reject(new Error('Disconnected'));
		await pending;
		expect(nodes.error).toBeNull();
		expect(nodes.isReady(remoteExecutionNode.id)).toBe(true);
	});

	it('distinguishes disabled, waiting, reconnecting, and offline states', () => {
		expect(executionNodeStatus({ ...remoteExecutionNode, enabled: false })).toBe('Disabled');
		expect(executionNodeStatus({ ...remoteExecutionNode, availability: 'offline' })).toBe('Waiting for connection');
		expect(executionNodeStatus({ ...remoteExecutionNode, availability: 'reconnecting' })).toBe('Reconnecting');
		expect(executionNodeStatus({ ...remoteExecutionNode, direction: 'controller-connects', availability: 'offline' })).toBe('Offline');
	});
});
