import { expect, it, vi } from 'vitest';
import { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import type { ExecutorSnapshot } from '$shared/executors';
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
	async (targetExecutor) => {
		const executors = new ExecutorsStore();
		executors.applySnapshot(
			['local', remoteId].map((id): ExecutorSnapshot => ({
				id,
				label: id,
				kind: id === 'local' ? 'local' : 'remote',
				enabled: true,
				direction: id === 'local' ? null : 'executor-connects',
				availability: 'ready',
				instanceId: null,
				projectBasePath: '/project',
				lastError: null,
				machineServices: { terminals: true, files: true, git: false, gh: false },
				allowControllerCli: false,
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
			executors,
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
			resolveCurrentProjectPath: async () => ({ executorId: targetExecutor, projectPath: '/project' }),
			currentProjectExecutorId: () => targetExecutor,
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
			if (targetExecutor === 'local') {
				await switching;
				expect(create).toHaveBeenCalledOnce();
				expect(create).toHaveBeenCalledWith(expect.objectContaining({ executorId: 'local' }));
			} else {
				await expect(switching).rejects.toThrow('Remote inventory failed');
				expect(create).not.toHaveBeenCalled();
			}
		} finally {
			registry.destroy();
		}
	},
);
