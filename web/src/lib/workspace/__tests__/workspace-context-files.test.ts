import { describe, expect, it, vi } from 'vitest';
import { WorkspaceContextStore } from '../workspace-context.svelte';
import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';

describe('executor-owned workspace files', () => {
	it('enables remote Files without enabling Git or terminals, and gates only the offline executor', () => {
		const sessions = createChatSessionsStore();
		for (const executorId of ['local', remoteExecutor.id]) {
			sessions.createDraft({
				id: executorId,
				projectPath: '/same',
				startup: {
					executorId,
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
			...remoteExecutor,
			machineServices: { files: true, git: false, gh: false, terminals: false },
		};
		const executors = new ExecutorsStore(async () => [localExecutor, remote]);
		executors.applySnapshot([localExecutor, remote]);
		const snapshotFor = vi.fn(() => ({ kind: 'available' as const, effectiveProjectKey: '/same' }));
		const workspace = new WorkspaceContextStore(
			sessions,
			new ModelCatalogStore(),
			{ snapshotFor },
			executors,
		);
		sessions.setSelectedChatId(remote.id);
		expect(workspace.filesProjectState).toMatchObject({
			kind: 'available',
			project: { executorId: remote.id, projectPath: '/same' },
		});
		expect(snapshotFor).toHaveBeenLastCalledWith({
			kind: 'path',
			executorId: remote.id,
			projectPath: '/same',
		});
		expect(workspace.projectState.kind).toBe('request-failed');
		expect(workspace.currentProject).toBeNull();
		executors.applySnapshot([localExecutor, { ...remote, availability: 'offline' }]);
		expect(workspace.filesProjectState.kind).toBe('request-failed');
		sessions.setSelectedChatId('local');
		expect(workspace.filesProjectState).toMatchObject({
			kind: 'available',
			project: { executorId: 'local' },
		});
		expect(workspace.projectState.kind).toBe('available');
	});
});
