import { describe, expect, it, vi } from 'vitest';
import {
	createWorkspaceLayoutStore,
	reduceWorkspaceLayout,
} from '$lib/stores/workspace-layout.svelte';
import { ChatInteractionGate } from '../chat-interaction-gate.svelte';
import { TransientLayerRegistry } from '../transient-layers.svelte';
import { WorkspaceCoordinator } from '../workspace-coordinator.svelte';
import { WorkspaceTransitionArbiter } from '../workspace-transition-arbiter';
import { CHAT_SURFACE_ID, fileSurfaceId, terminalSurfaceId } from '../surface-types';
import type { TerminalMetadata } from '$shared/terminal';
import { SurfaceFrameRegistry } from '../surface-frame-registry.svelte';
import { SurfaceFrameBridge } from '../surface-frame-context';
import { WorkspaceShortcutDispatcher } from '../workspace-shortcuts';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function terminalMetadata(terminalId: string): TerminalMetadata {
	return {
		terminalId,
		displaySequence: 1,
		initialWorkingDirectory: '/workspace',
		processStatus: 'running',
		attachmentStatus: 'attached',
		createdAt: '2026-07-13T00:00:00.000Z',
		exitCode: null,
		latestOutputSequence: 0,
	};
}

function createHarness(
	options: {
		confirmDestructive?: (sessionId: string) => Promise<boolean>;
		terminate?: (terminalId: string, requestId: string) => Promise<void>;
		surfaceFrames?: SurfaceFrameRegistry;
		fileEditor?: { prepareRendererTransfer(): void };
		filePendingMutationCount?: number;
		quickGitCanClose?: boolean;
		pendingGitSurfaceIds?: readonly string[];
		terminalPrepareRendererTransfer?: (terminalId: string) => void;
		initialMainSurfaceId?: string;
		onLayoutChanged?: () => void;
	} = {},
) {
	const layout = createWorkspaceLayoutStore();
	if (options.initialMainSurfaceId) {
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{ type: 'focus-host', host: 'main', surfaceId: options.initialMainSurfaceId },
			]),
		);
	}
	const chatInteractionGate = new ChatInteractionGate();
	const files = {
		confirmDestructive: options.confirmDestructive ?? vi.fn(async () => true),
		destroy: vi.fn(),
		get: vi.fn(() =>
			options.fileEditor || options.filePendingMutationCount !== undefined
				? {
						editor: options.fileEditor ?? null,
						pendingMutationCount: options.filePendingMutationCount ?? 0,
					}
				: null,
		),
	};
	const terminals = {
		sessions: {} as Record<
			string,
			{
				metadata: TerminalMetadata;
				attachmentState: 'attached';
			}
		>,
		requestTermination: options.terminate ?? vi.fn(async () => undefined),
		disposeTerminatedSession: vi.fn(),
		create: vi.fn(),
		pendingCreates: {} as Record<string, unknown>,
		prepareRendererTransfer:
			options.terminalPrepareRendererTransfer ?? vi.fn((_terminalId: string) => undefined),
	};
	const appShell = { isMobile: false };
	const quickGit = {
		canClose: options.quickGitCanClose ?? true,
		retainedDraftCount: 0,
		discardDrafts: vi.fn(),
		resetAfterClose: vi.fn(),
	};
	const singletons = {
		quickGit,
		quickGitIfPresent: () => quickGit,
		setPresentationVisible: vi.fn(),
		disposeSurface: vi.fn((kind: string) => {
			if (kind === 'quick-git') quickGit.resetAfterClose();
		}),
	};
	const transientLayers = new TransientLayerRegistry(chatInteractionGate);
	const coordinator = new WorkspaceCoordinator({
		arbiter: new WorkspaceTransitionArbiter(layout, layout),
		terminals: terminals as never,
		workspaceContext: { current: null } as never,
		appShell: appShell as never,
		chatSessions: { setSelectedChatId: vi.fn() } as never,
		chatInteractionGate,
		transientLayers,
		files: files as never,
		singletons: singletons as never,
		gitMutations: {
			pendingCount: (surfaceId: string) =>
				options.pendingGitSurfaceIds?.includes(surfaceId) ? 1 : 0,
		} as never,
		surfaceFrames: options.surfaceFrames,
		getRouteIdentity: () => '/',
		onLayoutChanged: options.onLayoutChanged,
	});
	return {
		coordinator,
		files,
		layout,
		terminals,
		appShell,
		singletons,
		chatInteractionGate,
		transientLayers,
	};
}

describe('WorkspaceCoordinator', () => {
	it('serializes dialog collisions and revalidates the occupant after each guard', async () => {
		const firstConfirmation = deferred<boolean>();
		const secondConfirmation = deferred<boolean>();
		const confirmations = [firstConfirmation, secondConfirmation];
		const confirmDestructive = vi.fn(() => confirmations.shift()!.promise);
		const { coordinator, files, layout } = createHarness({ confirmDestructive });
		await coordinator.placeFileSession('one', 'dialog');

		const second = coordinator.placeFileSession('two', 'dialog');
		const third = coordinator.placeFileSession('three', 'dialog');
		await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledTimes(1));
		firstConfirmation.resolve(true);
		await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledTimes(2));
		secondConfirmation.resolve(true);

		await expect(second).resolves.toBe(true);
		await expect(third).resolves.toBe(true);
		expect(layout.snapshot.dialogFileSurfaceId).toBe(fileSurfaceId('three'));
		expect(files.destroy).toHaveBeenNthCalledWith(1, 'one');
		expect(files.destroy).toHaveBeenNthCalledWith(2, 'two');
	});

	it('cancels a pending dialog replacement when responsive presentation changes', async () => {
		const confirmation = deferred<boolean>();
		const confirmDestructive = vi.fn(() => confirmation.promise);
		const { coordinator, layout, appShell } = createHarness({ confirmDestructive });
		await coordinator.placeFileSession('one', 'dialog');
		const replacement = coordinator.placeFileSession('two', 'dialog');
		await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledOnce());

		appShell.isMobile = true;
		await coordinator.enterMobilePresentation();
		confirmation.resolve(true);

		await expect(replacement).resolves.toBe(false);
		expect(layout.snapshot.dialogFileSurfaceId).toBe(fileSurfaceId('one'));
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(fileSurfaceId('one'));
		expect(layout.surface(fileSurfaceId('two'))).toBeNull();
	});

	it('rejects Move while terminal termination owns the destructive reservation', async () => {
		const termination = deferred<void>();
		const terminate = vi.fn(() => termination.promise);
		const { coordinator, layout, terminals } = createHarness({ terminate });
		const terminalId = 'terminal-1';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'main');
		const surfaceId = terminalSurfaceId(terminalId);

		const close = coordinator.closeSurface(surfaceId);
		expect(coordinator.closeGuardRequest?.surfaceId).toBe(surfaceId);
		coordinator.resolveCloseGuard(true);
		await Promise.resolve();
		await coordinator.moveSurface(surfaceId, 'sidebar');
		expect(layout.snapshot.main.order).toContain(surfaceId);
		expect(layout.snapshot.sidebar.order).not.toContain(surfaceId);

		termination.resolve();
		await expect(close).resolves.toBe(true);
		expect(layout.surface(surfaceId)).toBeNull();
		expect(terminals.disposeTerminatedSession).toHaveBeenCalledWith(terminalId);
	});

	it('removes a remotely terminated terminal after a local Close is cancelled', async () => {
		const { coordinator, layout, terminals } = createHarness();
		const terminalId = 'terminal-remote-cancel';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'main');
		const surfaceId = terminalSurfaceId(terminalId);

		const close = coordinator.closeSurface(surfaceId);
		expect(coordinator.closeGuardRequest?.surfaceId).toBe(surfaceId);
		await coordinator.handleTerminalSessionTerminated(terminalId);
		coordinator.resolveCloseGuard(false);

		await expect(close).resolves.toBe(false);
		expect(layout.surface(surfaceId)).toBeNull();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
	});

	it('joins remote termination into a confirmed local Close without another request', async () => {
		const { coordinator, layout, terminals } = createHarness();
		const terminalId = 'terminal-remote-confirm';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'main');
		const surfaceId = terminalSurfaceId(terminalId);

		const close = coordinator.closeSurface(surfaceId);
		expect(coordinator.closeGuardRequest?.surfaceId).toBe(surfaceId);
		await coordinator.handleTerminalSessionTerminated(terminalId);
		coordinator.resolveCloseGuard(true);

		await expect(close).resolves.toBe(true);
		expect(layout.surface(surfaceId)).toBeNull();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
	});

	it('blocks destructive Close while accepted file or Quick Git work is pending', async () => {
		const { coordinator, layout } = createHarness({
			filePendingMutationCount: 1,
			quickGitCanClose: false,
		});
		await coordinator.placeFileSession('saving', 'main');

		expect(coordinator.isSurfaceCloseBlocked(fileSurfaceId('saving'))).toBe(true);
		expect(coordinator.isSurfaceCloseBlocked('singleton:quick-git')).toBe(true);
		await expect(coordinator.closeSurface(fileSurfaceId('saving'))).resolves.toBe(false);
		await expect(coordinator.closeSurface('singleton:quick-git')).resolves.toBe(false);
		expect(layout.snapshot.main.order).toContain(fileSurfaceId('saving'));
		expect(layout.snapshot.sidebar.order).toContain('singleton:quick-git');
	});

	it('blocks the invoking Git singleton while its branch mutation is pending', async () => {
		const { coordinator } = createHarness({ pendingGitSurfaceIds: ['singleton:git'] });

		expect(coordinator.isSurfaceCloseBlocked('singleton:git')).toBe(true);
		await expect(coordinator.closeSurface('singleton:git')).resolves.toBe(false);
	});

	it('exits a concurrently enabled fullscreen mode when moving active main to sidebar', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.focusSurface('singleton:git');

		const enableFullscreen = coordinator.setManualFullscreen(true);
		const moveToSidebar = coordinator.moveSurface('singleton:git', 'sidebar');
		await Promise.all([enableFullscreen, moveToSidebar]);

		expect(layout.snapshot.manualFullscreen).toBe(false);
		expect(layout.snapshot.sidebar.order).toContain('singleton:git');
		expect(layout.snapshot.sidebar.activeId).toBe('singleton:git');
	});

	it('publishes placement before awaiting the exact destination frame', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const opening = coordinator.openSingleton('git', 'main');
		await vi.waitFor(() => expect(layout.snapshot.main.activeId).toBe('singleton:git'));
		expect(coordinator.frameVersion('singleton:git')).toBe(1);

		const attachRetainedRenderer = vi.fn();
		frames.register('singleton:git', 'main', {
			element: document.createElement('div'),
			attachRetainedRenderer,
			focusPrimary: vi.fn(),
		});
		await opening;

		expect(attachRetainedRenderer).toHaveBeenCalledOnce();
		expect(coordinator.attachmentErrors['singleton:git']).toBeUndefined();
	});

	it('reveals a retained renderer before retrying an attachment error', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const opening = coordinator.openSingleton('git', 'main');
		await vi.waitFor(() => expect(layout.snapshot.main.activeId).toBe('singleton:git'));
		const failedBridge = new SurfaceFrameBridge();
		const failedActivation = vi.fn(() => failedBridge.activate());
		frames.register('singleton:git', 'main', {
			element: document.createElement('div'),
			attachRetainedRenderer: failedActivation,
			focusPrimary: vi.fn(),
		});
		await vi.waitFor(() => expect(failedActivation).toHaveBeenCalledOnce());
		failedBridge.provideRenderer({
			attach: vi.fn(async () => {
				throw new Error('renderer failed');
			}),
			detach: vi.fn(),
			focusPrimary: vi.fn(),
		});
		await opening;
		expect(coordinator.attachmentErrors['singleton:git']).toBe('renderer failed');

		failedBridge.deactivate();
		const retry = coordinator.retryPresentation('singleton:git', 'main');
		expect(coordinator.attachmentErrors['singleton:git']).toBeUndefined();
		await vi.waitFor(() => expect(coordinator.frameVersion('singleton:git')).toBe(2));
		const retryBridge = new SurfaceFrameBridge();
		const attachRetainedRenderer = vi.fn(() => retryBridge.activate());
		frames.register('singleton:git', 'main', {
			element: document.createElement('div'),
			attachRetainedRenderer,
			focusPrimary: vi.fn(),
		});
		await vi.waitFor(() => expect(attachRetainedRenderer).toHaveBeenCalledOnce());
		retryBridge.provideRenderer({
			attach: vi.fn(),
			detach: vi.fn(),
			focusPrimary: vi.fn(),
		});
		await retry;

		expect(coordinator.attachmentErrors['singleton:git']).toBeUndefined();
	});

	it('updates Chat drop eligibility in the same transition that hides Chat', async () => {
		const { coordinator, chatInteractionGate } = createHarness();
		expect(chatInteractionGate.isChatDropEligible).toBe(true);

		await coordinator.focusSurface('singleton:git');

		expect(chatInteractionGate.isChatDropEligible).toBe(false);
		await coordinator.focusChat();
		expect(chatInteractionGate.isChatDropEligible).toBe(true);
	});

	it('publishes responsive mode with the layout and replaces a hidden focus owner', async () => {
		const { coordinator, appShell, layout } = createHarness();
		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:files' };
		coordinator.lastFocusedSurfaceId = CHAT_SURFACE_ID;

		await coordinator.enterMobilePresentation();

		expect(coordinator.isMobile).toBe(true);
		expect(appShell.isMobile).toBe(true);
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(CHAT_SURFACE_ID);
		expect(coordinator.focusOwner).toEqual({ kind: 'surface', surfaceId: CHAT_SURFACE_ID });
	});

	it('honors the newest responsive request when breakpoint changes overlap', async () => {
		const { coordinator, appShell } = createHarness();

		await Promise.all([
			coordinator.enterMobilePresentation(),
			coordinator.exitMobilePresentation(),
		]);

		expect(coordinator.isMobile).toBe(false);
		expect(appShell.isMobile).toBe(false);
	});

	it('does not route shortcuts through a stale hidden surface owner', () => {
		const { coordinator, transientLayers, appShell, files } = createHarness();
		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:files' };
		const dispatcher = new WorkspaceShortcutDispatcher({
			workspace: coordinator,
			transients: transientLayers,
			appShell: appShell as never,
			navigation: {} as never,
			files: files as never,
		});
		const handler = vi.fn(() => true);
		dispatcher.registerSurface('singleton:files', handler);

		dispatcher.handle(new KeyboardEvent('keydown', { key: 'x' }));

		expect(handler).not.toHaveBeenCalled();
	});

	it('initializes Chat drop eligibility from the restored presentation', () => {
		const { chatInteractionGate } = createHarness({
			initialMainSurfaceId: 'singleton:git',
		});

		expect(chatInteractionGate.isChatDropEligible).toBe(false);
	});

	it('does not restore focus or recency after a presentation is superseded', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const focusGit = coordinator.focusSurface('singleton:git');
		await vi.waitFor(() => expect(layout.snapshot.main.activeId).toBe('singleton:git'));

		const focusPullRequests = coordinator.focusSurface('singleton:pull-requests');
		await vi.waitFor(() => expect(layout.snapshot.main.activeId).toBe('singleton:pull-requests'));
		const focusPrimary = vi.fn();
		frames.register('singleton:pull-requests', 'main', {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary,
		});

		await Promise.all([focusGit, focusPullRequests]);
		expect(coordinator.lastFocusedSurfaceId).toBe('singleton:pull-requests');
		expect(focusPrimary).toHaveBeenCalledOnce();
	});

	it('focuses an existing sidebar surface by revealing its host', async () => {
		const { coordinator, layout } = createHarness();
		expect(layout.snapshot.sidebarOpen).toBe(false);

		await coordinator.focusSurface('singleton:files');

		expect(layout.snapshot.sidebarOpen).toBe(true);
		expect(layout.snapshot.sidebar.activeId).toBe('singleton:files');
	});

	it('coalesces concurrent singleton opens into one placement', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.closeSurface('singleton:quick-git');

		await Promise.all([
			coordinator.openSingleton('quick-git', 'sidebar'),
			coordinator.openSingleton('quick-git', 'sidebar'),
		]);

		expect(layout.snapshot.sidebar.order.filter((id) => id === 'singleton:quick-git')).toHaveLength(
			1,
		);
		expect(layout.snapshot.sidebar.activeId).toBe('singleton:quick-git');
	});

	it('derives the Terminal launcher only while first-run layout is still canonical', async () => {
		const canonical = createHarness();
		await canonical.coordinator.reconcileTerminals([], { deriveLauncher: true });
		expect(canonical.layout.snapshot.main.order).toContain('terminal-launcher');

		const changed = createHarness();
		await changed.coordinator.focusSurface('singleton:git');
		await changed.coordinator.reconcileTerminals([], { deriveLauncher: true });
		expect(changed.layout.snapshot.main.order).not.toContain('terminal-launcher');
	});

	it('reuses the launcher Create request ID after an indeterminate response', async () => {
		const { coordinator, terminals, layout } = createHarness();
		await coordinator.reconcileTerminals([], { deriveLauncher: true });
		const requestIds: string[] = [];
		terminals.create
			.mockImplementationOnce(async (_directory: string | null, requestId: string) => {
				requestIds.push(requestId);
				terminals.pendingCreates[requestId] = {};
				throw new Error('network lost');
			})
			.mockImplementationOnce(async (_directory: string | null, requestId: string) => {
				requestIds.push(requestId);
				delete terminals.pendingCreates[requestId];
				return 'terminal-recovered';
			});

		await expect(coordinator.activateTerminalLauncher('main')).rejects.toThrow('network lost');
		await expect(coordinator.activateTerminalLauncher('main')).resolves.toBeUndefined();

		expect(requestIds[1]).toBe(requestIds[0]);
		expect(layout.snapshot.main.order).toContain(terminalSurfaceId('terminal-recovered'));
	});

	it('uses a distinct request ID for each concurrent New Terminal action', async () => {
		const { coordinator, terminals, layout } = createHarness();
		const requestIds: string[] = [];
		terminals.create.mockImplementation(async (_directory: string | null, requestId: string) => {
			requestIds.push(requestId);
			return `terminal-${requestIds.length}`;
		});

		await Promise.all([coordinator.createTerminal('main'), coordinator.createTerminal('main')]);

		expect(new Set(requestIds).size).toBe(2);
		expect(layout.snapshot.main.order).toContain(terminalSurfaceId('terminal-1'));
		expect(layout.snapshot.main.order).toContain(terminalSurfaceId('terminal-2'));
	});

	it('keeps the launcher reserved until a created terminal replaces it', async () => {
		const creation = deferred<string>();
		const { coordinator, terminals, layout } = createHarness();
		await coordinator.reconcileTerminals([], { deriveLauncher: true });
		terminals.create.mockImplementation(() => creation.promise);

		const activation = coordinator.activateTerminalLauncher('main');
		await Promise.resolve();
		await coordinator.activateTerminalLauncher('main');
		await coordinator.reconcileTerminals(['terminal-race'], { deriveLauncher: true });

		expect(terminals.create).toHaveBeenCalledOnce();
		expect(layout.snapshot.main.order).toContain('terminal-launcher');

		creation.resolve('terminal-race');
		await activation;

		expect(layout.snapshot.main.order).not.toContain('terminal-launcher');
		expect(layout.snapshot.main.order).toContain(terminalSurfaceId('terminal-race'));
		expect(layout.snapshot.main.activeId).toBe(terminalSurfaceId('terminal-race'));
	});

	it('reuses a Terminate request ID after an indeterminate response', async () => {
		const requestIds: string[] = [];
		const terminate = vi
			.fn()
			.mockImplementationOnce(async (_terminalId: string, requestId: string) => {
				requestIds.push(requestId);
				throw new TypeError('network lost');
			})
			.mockImplementationOnce(async (_terminalId: string, requestId: string) => {
				requestIds.push(requestId);
			});
		const { coordinator, terminals, layout } = createHarness({ terminate });
		const terminalId = 'terminal-1';
		terminals.sessions[terminalId] = {
			metadata: { ...terminalMetadata(terminalId), processStatus: 'exited' },
			attachmentState: 'detached',
		} as never;
		await coordinator.openTerminalSession(terminalId, 'main');
		const surfaceId = terminalSurfaceId(terminalId);

		await expect(coordinator.closeSurface(surfaceId)).rejects.toThrow('network lost');
		expect(layout.surface(surfaceId)).not.toBeNull();
		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

		expect(requestIds[1]).toBe(requestIds[0]);
		expect(layout.surface(surfaceId)).toBeNull();
	});

	it('removes a remotely terminated terminal surface without another terminate request', async () => {
		const { coordinator, terminals, layout } = createHarness();
		const terminalId = 'terminal-remote';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		} as never;
		const surfaceId = terminalSurfaceId(terminalId);
		await coordinator.openTerminalSession(terminalId, 'sidebar');

		await coordinator.handleTerminalSessionTerminated(terminalId);

		expect(layout.surface(surfaceId)).toBeNull();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
	});

	it('removes and disposes a terminated terminal when renderer deactivation fails', async () => {
		const frames = new SurfaceFrameRegistry();
		const prepareRendererTransfer = vi.fn(() => {
			throw new Error('renderer parking failed');
		});
		const { coordinator, terminals, layout } = createHarness({
			surfaceFrames: frames,
			terminalPrepareRendererTransfer: prepareRendererTransfer,
		});
		const terminalId = 'terminal-destroyed';
		terminals.sessions[terminalId] = {
			metadata: { ...terminalMetadata(terminalId), processStatus: 'exited' },
			attachmentState: 'detached',
		} as never;
		const surfaceId = terminalSurfaceId(terminalId);
		const opening = coordinator.openTerminalSession(terminalId, 'main');
		await vi.waitFor(() => expect(layout.snapshot.main.activeId).toBe(surfaceId));
		frames.register(surfaceId, 'main', {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary: vi.fn(),
		});
		await opening;

		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

		expect(prepareRendererTransfer).toHaveBeenCalledWith(terminalId);
		expect(layout.surface(surfaceId)).toBeNull();
		expect(terminals.disposeTerminatedSession).toHaveBeenCalledWith(terminalId);
	});

	it('removes and disposes a terminated terminal when layout persistence fails', async () => {
		const onLayoutChanged = vi.fn();
		const { coordinator, terminals, layout } = createHarness({ onLayoutChanged });
		const terminalId = 'terminal-persistence-failure';
		terminals.sessions[terminalId] = {
			metadata: { ...terminalMetadata(terminalId), processStatus: 'exited' },
			attachmentState: 'detached',
		} as never;
		const surfaceId = terminalSurfaceId(terminalId);
		await coordinator.openTerminalSession(terminalId, 'main');
		onLayoutChanged.mockImplementation(() => {
			throw new Error('storage unavailable');
		});

		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

		expect(layout.surface(surfaceId)).toBeNull();
		expect(terminals.disposeTerminatedSession).toHaveBeenCalledWith(terminalId);
	});

	it('reserves a dialog source while a dirty collision is pending', async () => {
		const confirmation = deferred<boolean>();
		const confirmDestructive = vi.fn(() => confirmation.promise);
		const { coordinator, layout } = createHarness({ confirmDestructive });
		await coordinator.placeFileSession('dialog', 'dialog');
		await coordinator.placeFileSession('source', 'main');

		const popOut = coordinator.popOutFile(fileSurfaceId('source'));
		await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledOnce());
		await expect(coordinator.closeSurface(fileSurfaceId('source'))).resolves.toBe(false);
		expect(layout.snapshot.main.order).toContain(fileSurfaceId('source'));

		confirmation.resolve(false);
		await expect(popOut).resolves.toBe(false);
	});

	it('transfers a dialog renderer through mobile and back to the dialog frame', async () => {
		const frames = new SurfaceFrameRegistry();
		const editor = { prepareRendererTransfer: vi.fn() };
		const { coordinator, layout, appShell } = createHarness({
			surfaceFrames: frames,
			fileEditor: editor,
		});
		const surfaceId = fileSurfaceId('dialog');
		const open = coordinator.placeFileSession('dialog', 'dialog');
		await vi.waitFor(() => expect(layout.snapshot.dialogFileSurfaceId).toBe(surfaceId));
		frames.register(surfaceId, 'dialog', {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary: vi.fn(),
		});
		await open;

		appShell.isMobile = true;
		const enter = coordinator.enterMobilePresentation();
		await vi.waitFor(() => expect(layout.snapshot.mobileActiveSurfaceId).toBe(surfaceId));
		const attachMobile = vi.fn();
		frames.register(surfaceId, 'mobile', {
			element: document.createElement('div'),
			attachRetainedRenderer: attachMobile,
			focusPrimary: vi.fn(),
		});
		await enter;

		appShell.isMobile = false;
		const exit = coordinator.exitMobilePresentation();
		await vi.waitFor(() => expect(coordinator.frameVersion(surfaceId)).toBe(3));
		const attachDialog = vi.fn();
		frames.register(surfaceId, 'dialog', {
			element: document.createElement('div'),
			attachRetainedRenderer: attachDialog,
			focusPrimary: vi.fn(),
		});
		await exit;

		expect(editor.prepareRendererTransfer).toHaveBeenCalledTimes(2);
		expect(attachMobile).toHaveBeenCalledOnce();
		expect(attachDialog).toHaveBeenCalledOnce();
	});
});
