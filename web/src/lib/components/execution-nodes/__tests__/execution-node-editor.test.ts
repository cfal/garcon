import { describe, expect, it, vi } from 'vitest';
import type * as api from '$lib/api/execution-nodes';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte';
import { localExecutionNode, remoteExecutionNode } from '$lib/execution-nodes/__tests__/fixtures';
import type { ExecutionNodeConnection, ExecutionNodeSnapshot } from '$shared/execution-nodes';
import { ExecutionNodeEditor } from '../execution-node-editor.svelte';

const connection = {
	connectionUrl: `wss://example.test/execution-node/${remoteExecutionNode.id}#secret=synthetic`,
	allowInsecureDevelopment: false,
	allowUnverifiedTls: false,
} satisfies ExecutionNodeConnection;

function fixture() {
	const read = vi.fn<typeof api.getExecutionNodes>(async () => [localExecutionNode, remoteExecutionNode]);
	const nodes = new ExecutionNodesStore(read);
	nodes.applySnapshot([localExecutionNode, remoteExecutionNode]);
	const transport = {
		getExecutionNodes: read,
		createExecutionNode: vi.fn<typeof api.createExecutionNode>(async () => ({ id: remoteExecutionNode.id, ...connection })),
		getExecutionNodeConnection: vi.fn<typeof api.getExecutionNodeConnection>(async () => connection),
		updateExecutionNode: vi.fn<typeof api.updateExecutionNode>(async () => [localExecutionNode, remoteExecutionNode]),
		removeExecutionNode: vi.fn<typeof api.removeExecutionNode>(async () => [localExecutionNode]),
	} satisfies typeof api;
	return { nodes, read, transport, editor: new ExecutionNodeEditor(nodes, transport) };
}

describe('ExecutionNodeEditor', () => {
	it('refreshes creation after a held pre-create snapshot without WebSocket delivery', async () => {
		const { editor, nodes, read } = fixture();
		const response = Promise.withResolvers<readonly ExecutionNodeSnapshot[]>();
		read.mockReturnValueOnce(response.promise);
		const discovery = nodes.refresh();
		editor.label = 'New worker';
		const saving = editor.save();
		response.resolve([localExecutionNode]);
		await discovery;
		expect(await saving).toBe(true);
		expect(read).toHaveBeenCalledTimes(2);
		expect(nodes.get(remoteExecutionNode.id)).toEqual(remoteExecutionNode);
	});

	it('creates an inbound node and keeps its connection URL only in editor state', async () => {
		const { editor, nodes, transport } = fixture();
		editor.label = ' Build Machine ';
		expect(await editor.save()).toBe(true);
		expect(transport.createExecutionNode).toHaveBeenCalledWith({
			label: 'Build Machine', direction: 'node-connects', allowInsecureDevelopment: false, allowUnverifiedTls: false,
		});
		expect(editor.id).toBe(remoteExecutionNode.id);
		expect(editor.connectionUrl).toBe(connection.connectionUrl);
		expect(JSON.stringify(nodes.nodes)).not.toContain('secret');
		editor.clear();
		expect(editor.connectionUrl).toBe('');
	});

	it('passes a pasted listener URL through the outbound creation contract', async () => {
		const { editor, transport } = fixture();
		editor.label = 'Worker';
		editor.direction = 'controller-connects';
		editor.connectionUrl = 'ws://worker.test:1234/execution-node#secret=synthetic';
		editor.allowInsecureDevelopment = true;
		await editor.save();
		expect(transport.createExecutionNode).toHaveBeenCalledWith({
			label: 'Worker', direction: 'controller-connects', allowInsecureDevelopment: true, allowUnverifiedTls: false,
			connectionUrl: 'ws://worker.test:1234/execution-node#secret=synthetic',
		});
	});

	it('omits a connection edit for a rename', async () => {
		const { editor, transport } = fixture();
		await editor.edit(remoteExecutionNode);
		editor.label = 'Renamed';
		await editor.save();
		expect(transport.updateExecutionNode).toHaveBeenCalledWith(remoteExecutionNode.id, {
			label: 'Renamed',
		});
		editor.connectionUrl = connection.connectionUrl.replace('example.test', 'controller.test');
		await editor.save();
		expect(transport.updateExecutionNode).toHaveBeenLastCalledWith(remoteExecutionNode.id, {
			label: 'Renamed',
			connection: { direction: 'node-connects', connectionUrl: editor.connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: false },
		});
		editor.enabled = false;
		await editor.save();
		expect(transport.updateExecutionNode).toHaveBeenLastCalledWith(remoteExecutionNode.id, { label: 'Renamed', enabled: false });
	});

	it('persists certificate opt-out only for outbound connections and clears it with the editor', async () => {
		const { editor, transport } = fixture();
		await editor.edit({ ...remoteExecutionNode, direction: 'controller-connects' });
		expect(editor.allowUnverifiedTls).toBe(false);
		editor.allowUnverifiedTls = true;
		await editor.save();
		expect(transport.updateExecutionNode).toHaveBeenLastCalledWith(remoteExecutionNode.id, {
			label: remoteExecutionNode.label,
			connection: { direction: 'controller-connects', connectionUrl: editor.connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true },
		});
		editor.direction = 'node-connects';
		await editor.save();
		expect(transport.updateExecutionNode.mock.lastCall?.[1].connection?.allowUnverifiedTls).toBe(false);
		editor.clear();
		expect(editor.allowUnverifiedTls).toBe(false);
	});

	it('does not restore a secret after the editor closes during reveal', async () => {
		const { editor, transport } = fixture();
		const response = Promise.withResolvers<ExecutionNodeConnection>();
		transport.getExecutionNodeConnection.mockReturnValue(response.promise);
		const pending = editor.edit(remoteExecutionNode);
		editor.clear();
		response.resolve(connection);
		await pending;
		expect(editor.id).toBeNull();
		expect(editor.connectionUrl).toBe('');
		expect(editor.busy).toBe(false);
	});

	it('does not replace newer pushed readiness with an old save response', async () => {
		const { editor, transport, nodes, read } = fixture();
		await editor.edit(remoteExecutionNode);
		const response = Promise.withResolvers<readonly ExecutionNodeSnapshot[]>();
		transport.updateExecutionNode.mockReturnValue(response.promise);
		const pending = editor.save();
		nodes.applySnapshot([localExecutionNode, remoteExecutionNode]);
		response.resolve([localExecutionNode, { ...remoteExecutionNode, availability: 'offline' }]);
		await pending;
		expect(read).toHaveBeenCalledTimes(1);
		expect(nodes.isReady(remoteExecutionNode.id)).toBe(true);
	});

	it('requires delete confirmation and preserves errors without claiming deletion', async () => {
		const { editor, transport, nodes } = fixture();
		await editor.edit(remoteExecutionNode);
		expect(await editor.remove()).toBe(false);
		expect(transport.removeExecutionNode).not.toHaveBeenCalled();
		editor.confirmDelete = true;
		transport.removeExecutionNode.mockRejectedValueOnce(new Error('Node is in use'));
		expect(await editor.remove()).toBe(false);
		expect(editor.error).toBe('Node is in use');
		expect(nodes.get(remoteExecutionNode.id)).toBeDefined();
		expect(await editor.remove()).toBe(true);
		expect(nodes.get(remoteExecutionNode.id)).toBeUndefined();
		expect(editor.connectionUrl).toBe('');
	});
});
