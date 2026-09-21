import { describe, expect, it, vi } from 'vitest';
import { WorkspaceContextStore } from '../workspace-context.svelte';
import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte';
import { localExecutionNode, remoteExecutionNode } from '$lib/execution-nodes/__tests__/fixtures';

describe('node-owned workspace files', () => {
	it('enables remote Files without enabling Git or terminals, and gates only the offline node', () => {
		const sessions = createChatSessionsStore();
		for (const nodeId of ['local', remoteExecutionNode.id]) {
			sessions.createDraft({
				id: nodeId,
				projectPath: '/same',
				startup: {
					nodeId,
					agentId: 'claude',
					model: 'opus',
					permissionMode: 'default',
					thinkingMode: 'none',
					agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
					firstMessage: '',
				},
			});
		}
		const remote = {
			...remoteExecutionNode,
			machineServices: { files: true, git: false, terminals: false },
		};
		const nodes = new ExecutionNodesStore(async () => [localExecutionNode, remote]);
		nodes.applySnapshot([localExecutionNode, remote]);
		const snapshotFor = vi.fn(() => ({ kind: 'available' as const, effectiveProjectKey: '/same' }));
		const workspace = new WorkspaceContextStore(
			sessions,
			new ModelCatalogStore(),
			{ snapshotFor },
			nodes,
		);
		sessions.setSelectedChatId(remote.id);
		expect(workspace.filesProjectState).toMatchObject({
			kind: 'available',
			project: { nodeId: remote.id, projectPath: '/same' },
		});
		expect(snapshotFor).toHaveBeenLastCalledWith({
			kind: 'path',
			nodeId: remote.id,
			projectPath: '/same',
		});
		expect(workspace.projectState.kind).toBe('request-failed');
		expect(workspace.currentProject).toBeNull();
		nodes.applySnapshot([localExecutionNode, { ...remote, availability: 'offline' }]);
		expect(workspace.filesProjectState.kind).toBe('request-failed');
		sessions.setSelectedChatId('local');
		expect(workspace.filesProjectState).toMatchObject({
			kind: 'available',
			project: { nodeId: 'local' },
		});
		expect(workspace.projectState.kind).toBe('available');
	});
});
