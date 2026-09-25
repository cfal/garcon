import { afterEach, expect, it, vi } from 'vitest';
import { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import type {
	TerminalCreateResponse,
	TerminalListResponse,
	TerminalMetadata,
} from '$shared/terminal';
import { createWorkspaceLayoutStore } from '../workspace-layout.svelte.js';
import { WorkspaceTransitionArbiter } from '../workspace-transition-arbiter.js';
import { TerminalPlacementService } from '../terminal-placement-service.js';
import { TerminalLayoutBinding } from '../terminal-layout-binding.js';
import { CANONICAL_CHAT_SURFACE_ID } from '../canonical-layout.js';
import { TERMINAL_LAUNCHER_ID, terminalSurfaceId } from '../surface-types.js';
import { allowWorkspaceSplit } from './workspace-geometry-test-fixtures.js';

const executorId = '00000000-0000-4000-8000-000000000001';
const runtimeId = '00000000-0000-4000-8000-000000000002';
const replacementRuntimeId = '00000000-0000-4000-8000-000000000003';
const terminal: TerminalMetadata = {
	terminalId: `${executorId}/${runtimeId}/00000000-0000-4000-8000-000000000004`,
	title: null,
	displaySequence: 1,
	initialWorkingDirectory: '/project',
	processStatus: 'running',
	attachmentStatus: 'detached',
	createdAt: '2026-01-01T00:00:00.000Z',
	exitCode: null,
	latestOutputSequence: 0,
};
const inventory = (id = runtimeId): TerminalListResponse => ({
	success: true,
	terminalRuntimeId: id,
	attachmentEpoch: 'epoch',
	terminals: [],
});
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

it.each(['tab', 'new window', 'replacement', 'launcher'])(
	'does not publish an obsolete runtime through %s creation after executor reconciliation',
	async (entryPoint) => {
		const executors = new ExecutorsStore();
		executors.applySnapshot([
			{
				id: executorId,
				label: 'Worker',
				kind: 'remote',
				enabled: true,
				direction: 'executor-connects',
				availability: 'ready',
				instanceId: null,
				projectBasePath: '/project',
				lastError: null,
				machineServices: { terminals: true, files: true, git: false, gh: false },
				allowControllerCli: false,
			},
		]);
		const creation = Promise.withResolvers<TerminalCreateResponse>();
		const replacement = Promise.withResolvers<TerminalListResponse>();
		const create = vi.fn(() => creation.promise);
		const list = vi.fn(async () => inventory());
		const terminate = vi.fn(async () => ({
			success: true as const,
			terminalId: terminal.terminalId,
			terminal: null,
		}));
		const layout = createWorkspaceLayoutStore();
		const arbiter = new WorkspaceTransitionArbiter(layout, layout);
		const registry = new TerminalRegistry({
			executors,
			connection: {
				isConnected: true,
				sendMessage: () => true,
				addMessageConsumer: () => () => {},
				onConnectionChange: () => () => {},
			},
			getClientId: () => 'browser',
			listTerminals: list,
			createTerminal: create,
			terminateTerminal: terminate,
			createTransport: () => ({
				status: 'idle',
				connect() {},
				send: () => false,
				suspend() {},
				destroy() {},
			}),
			onSuccessfulList: (ids, executor) => binding.handleSuccessfulList(ids, executor),
		});
		cleanup.push(() => registry.destroy());
		const present = vi.fn();
		const placement = new TerminalPlacementService({
			layout,
			terminals: registry,
			reservations: new Set(),
			isWindowReserved: () => false,
			commit: (plan) => arbiter.commit(plan),
			commitDestroyedRemoval: (_id, plan) => arbiter.commit(plan),
			resolveCurrentProjectPath: async () => ({ executorId, projectPath: '/project' }),
			currentProjectExecutorId: () => executorId,
			isMobile: () => false,
			cancelWorkspaceDrag() {},
			windowOf: () => layout.defaultWindowId,
			defaultWindowId: () => layout.defaultWindowId,
			defaultActiveId: () => CANONICAL_CHAT_SURFACE_ID,
			lastFocusedSurfaceId: () => CANONICAL_CHAT_SURFACE_ID,
			focusSurface: async () => {},
			present,
			resolveMobileReturn: () => ({ activeId: CANONICAL_CHAT_SURFACE_ID, returnStack: [] }),
			confirmClose: async () => true,
			clearAttachmentError() {},
			resolveSplitAdmission: allowWorkspaceSplit,
		});
		const binding = new TerminalLayoutBinding({
			workspace: { reconcileTerminals: (ids, options) => placement.reconcile(ids, options) },
			restoreSource: 'valid',
			isLauncherDismissed: () => false,
			onError: (error) => {
				throw error;
			},
		});
		cleanup.push(() => binding.destroy());
		await registry.initialize();
		const sourceId = `local/${runtimeId}/00000000-0000-4000-8000-000000000005`;
		if (entryPoint === 'replacement') {
			await arbiter.commit([
				{
					type: 'register-surface',
					windowId: layout.defaultWindowId,
					surface: { id: terminalSurfaceId(sourceId), type: 'terminal', terminalId: sourceId },
				},
			]);
		} else if (entryPoint === 'launcher') {
			await placement.reconcile([], { deriveLauncher: true });
			expect(layout.surface(TERMINAL_LAUNCHER_ID)).not.toBeNull();
		}
		const placing =
			entryPoint === 'tab'
				? placement.create(layout.defaultWindowId, 'create', executorId)
				: entryPoint === 'new window'
					? placement.createInNewWindow(layout.defaultWindowId, 'create', executorId)
					: entryPoint === 'replacement'
						? placement.createReplacing(sourceId, 'create', executorId)
						: placement.activateLauncher(layout.defaultWindowId, executorId);
		const result = expect(placing).rejects.toThrow('Terminal is no longer available');
		await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
		list.mockImplementationOnce(() => replacement.promise);
		const listing = registry.list(executorId);
		await Promise.resolve();
		creation.resolve({ success: true, terminal });
		replacement.resolve(inventory(replacementRuntimeId));
		await listing;
		await result;
		await arbiter.commit([]);
		expect(registry.sessions).toEqual({});
		expect(layout.surface(terminalSurfaceId(terminal.terminalId))).toBeNull();
		expect(layout.snapshot.unplacedTerminalIds).not.toContain(terminal.terminalId);
		expect(present).not.toHaveBeenCalled();
		expect(terminate).not.toHaveBeenCalled();
		if (entryPoint === 'replacement')
			expect(layout.surface(terminalSurfaceId(sourceId))).not.toBeNull();
		if (entryPoint === 'launcher') expect(layout.surface(TERMINAL_LAUNCHER_ID)).not.toBeNull();
	},
);
