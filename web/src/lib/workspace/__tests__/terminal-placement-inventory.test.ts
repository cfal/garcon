import { expect, it, vi } from 'vitest';
import { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import type { ExecutionNodeSnapshot } from '$shared/execution-nodes';
import type { TerminalMetadata } from '$shared/terminal';
import { createWorkspaceLayoutStore } from '../workspace-layout.svelte.js';
import { WorkspaceTransitionArbiter } from '../workspace-transition-arbiter.js';
import { TerminalPlacementService } from '../terminal-placement-service.js';
import { CANONICAL_CHAT_SURFACE_ID } from '../canonical-layout.js';
import { allowWorkspaceSplit } from './workspace-geometry-test-fixtures.js';

const remoteId = '00000000-0000-4000-8000-000000000001';
const runtimeId = '00000000-0000-4000-8000-000000000002';

it.each(['local', remoteId])(
	'isolates empty-state creation on %s from another inventory failure',
	async (targetNode) => {
		const nodes = new ExecutionNodesStore();
		nodes.applySnapshot(
			['local', remoteId].map((id): ExecutionNodeSnapshot => ({
				id,
				label: id,
				kind: id === 'local' ? 'local' : 'remote',
				enabled: true,
				direction: id === 'local' ? null : 'node-connects',
				availability: 'ready',
				instanceId: null,
				projectBasePath: '/project',
				lastError: null,
				machineServices: { terminals: true, files: true, git: false, gh: false },
			})),
		);
		const metadata: TerminalMetadata = {
			terminalId: `local/${runtimeId}/00000000-0000-4000-8000-000000000003`,
			displaySequence: 1,
			title: null,
			initialWorkingDirectory: '/project',
			processStatus: 'running',
			attachmentStatus: 'detached',
			createdAt: '2026-01-01T00:00:00Z',
			exitCode: null,
			latestOutputSequence: 0,
		};
		const create = vi.fn(async () => ({ success: true as const, terminal: metadata }));
		const registry = new TerminalRegistry({
			nodes,
			connection: {
				isConnected: false,
				sendMessage: () => false,
				addMessageConsumer: () => () => {},
				onConnectionChange: () => () => {},
			},
			getClientId: () => 'browser',
			listTerminals: async (id = 'local') => {
				if (id === remoteId) throw new Error('Remote inventory failed');
				return {
					success: true,
					terminalRuntimeId: runtimeId,
					attachmentEpoch: 'epoch',
					terminals: [],
				};
			},
			createTerminal: create,
			createTransport: () => ({
				status: 'idle',
				connect() {},
				send: () => false,
				suspend() {},
				destroy() {},
			}),
		});
		const layout = createWorkspaceLayoutStore();
		const arbiter = new WorkspaceTransitionArbiter(layout, layout);
		const placement = new TerminalPlacementService({
			layout,
			terminals: registry,
			reservations: new Set(),
			isWindowReserved: () => false,
			commit: (plan) => arbiter.commit(plan),
			commitDestroyedRemoval: (_id, plan) => arbiter.commit(plan),
			resolveCurrentProjectPath: async () => ({ nodeId: targetNode, projectPath: '/project' }),
			currentProjectNodeId: () => targetNode,
			isMobile: () => false,
			cancelWorkspaceDrag() {},
			windowOf: () => layout.defaultWindowId,
			defaultWindowId: () => layout.defaultWindowId,
			defaultActiveId: () => CANONICAL_CHAT_SURFACE_ID,
			lastFocusedSurfaceId: () => CANONICAL_CHAT_SURFACE_ID,
			focusSurface: async () => {},
			present() {},
			resolveMobileReturn: () => ({ activeId: CANONICAL_CHAT_SURFACE_ID, returnStack: [] }),
			confirmClose: async () => true,
			clearAttachmentError() {},
			resolveSplitAdmission: allowWorkspaceSplit,
		});
		try {
			await registry.list('local');
			await expect(registry.list(remoteId)).rejects.toThrow('Remote inventory failed');
			const switching = placement.focusMostRecentOrCreate(layout.defaultWindowId);
			if (targetNode === 'local') {
				await switching;
				expect(create).toHaveBeenCalledOnce();
				expect(create).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'local' }));
			} else {
				await expect(switching).rejects.toThrow('Remote inventory failed');
				expect(create).not.toHaveBeenCalled();
			}
		} finally {
			registry.destroy();
		}
	},
);
