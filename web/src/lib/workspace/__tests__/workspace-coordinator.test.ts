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
import type { WorkspaceLayoutSnapshot } from '../surface-types';

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
		commitCanClose?: boolean;
		pendingGitSurfaceIds?: readonly string[];
		terminalPrepareRendererTransfer?: (terminalId: string) => void;
		initialMainSurfaceId?: string;
		onLayoutChanged?: () => void;
		onTerminalLauncherDismissed?: () => void;
		failLayoutPublishAt?: number;
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
	const commit = {
		canClose: options.commitCanClose ?? true,
		retainedDraftCount: 0,
		discardDrafts: vi.fn(),
		resetAfterClose: vi.fn(),
	};
	const singletons = {
		commit,
		commitIfPresent: () => commit,
		setPresentationVisible: vi.fn(),
		disposeSurface: vi.fn((kind: string) => {
			if (kind === 'commit') commit.resetAfterClose();
		}),
	};
	const transientLayers = new TransientLayerRegistry(chatInteractionGate);
	let publishCount = 0;
	const commitPort = options.failLayoutPublishAt
		? {
				publish(expectedRevision: number, next: WorkspaceLayoutSnapshot) {
					publishCount += 1;
					if (publishCount === options.failLayoutPublishAt) {
						throw new Error('layout publication failed');
					}
					return layout.publish(expectedRevision, next);
				},
			}
		: layout;
	const coordinator = new WorkspaceCoordinator({
		arbiter: new WorkspaceTransitionArbiter(layout, commitPort),
		terminals: terminals as never,
		workspaceContext: { current: null } as never,
		appShell: appShell as never,
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
		onTerminalLauncherDismissed: options.onTerminalLauncherDismissed,
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

	it('closes a terminal tab without terminating its session and can reopen it', async () => {
		const { coordinator, layout, terminals } = createHarness();
		const terminalId = 'terminal-unplaced';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'main');
		const surfaceId = terminalSurfaceId(terminalId);

		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

		expect(coordinator.closeGuardRequest).toBeNull();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
		expect(terminals.disposeTerminatedSession).not.toHaveBeenCalled();
		expect(terminals.sessions[terminalId]).toBeTruthy();
		expect(layout.surface(surfaceId)).toBeNull();
		expect(layout.snapshot.unplacedTerminalIds).toContain(terminalId);
		await coordinator.reconcileTerminals([terminalId], { deriveLauncher: false });
		expect(layout.surface(surfaceId)).toBeNull();
		expect(layout.snapshot.unplacedTerminalIds).toContain(terminalId);

		await coordinator.openTerminalSession(terminalId, 'sidebar');
		expect(layout.snapshot.sidebar.order).toContain(surfaceId);
		expect(layout.snapshot.unplacedTerminalIds).not.toContain(terminalId);
	});

	it('rejects Move while explicit terminal termination owns the destructive reservation', async () => {
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

		const terminationRequest = coordinator.terminateTerminalSession(terminalId);
		expect(coordinator.closeGuardRequest?.surfaceId).toBe(surfaceId);
		coordinator.resolveCloseGuard(true);
		await Promise.resolve();
		await coordinator.moveSurface(surfaceId, 'sidebar');
		expect(layout.snapshot.main.order).toContain(surfaceId);
		expect(layout.snapshot.sidebar.order).not.toContain(surfaceId);

		termination.resolve();
		await expect(terminationRequest).resolves.toBe(true);
		expect(layout.surface(surfaceId)).toBeNull();
		expect(terminals.disposeTerminatedSession).toHaveBeenCalledWith(terminalId);
	});

	it('removes a remotely terminated terminal after local Terminate is cancelled', async () => {
		const { coordinator, layout, terminals } = createHarness();
		const terminalId = 'terminal-remote-cancel';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'main');
		const surfaceId = terminalSurfaceId(terminalId);

		const terminate = coordinator.terminateTerminalSession(terminalId);
		expect(coordinator.closeGuardRequest?.surfaceId).toBe(surfaceId);
		await coordinator.handleTerminalSessionTerminated(terminalId);
		coordinator.resolveCloseGuard(false);

		await expect(terminate).resolves.toBe(false);
		expect(layout.surface(surfaceId)).toBeNull();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
	});

	it('joins remote termination into a confirmed local Terminate without another request', async () => {
		const { coordinator, layout, terminals } = createHarness();
		const terminalId = 'terminal-remote-confirm';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'main');
		const surfaceId = terminalSurfaceId(terminalId);

		const terminate = coordinator.terminateTerminalSession(terminalId);
		expect(coordinator.closeGuardRequest?.surfaceId).toBe(surfaceId);
		await coordinator.handleTerminalSessionTerminated(terminalId);
		coordinator.resolveCloseGuard(true);

		await expect(terminate).resolves.toBe(true);
		expect(layout.surface(surfaceId)).toBeNull();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
	});

	it('blocks destructive Close while accepted file or Commit work is pending', async () => {
		const { coordinator, layout } = createHarness({
			filePendingMutationCount: 1,
			commitCanClose: false,
		});
		await coordinator.placeFileSession('saving', 'main');

		expect(coordinator.isSurfaceCloseBlocked(fileSurfaceId('saving'))).toBe(true);
		expect(coordinator.isSurfaceCloseBlocked('singleton:commit')).toBe(true);
		await expect(coordinator.closeSurface(fileSurfaceId('saving'))).resolves.toBe(false);
		await expect(coordinator.closeSurface('singleton:commit')).resolves.toBe(false);
		expect(layout.snapshot.main.order).toContain(fileSurfaceId('saving'));
		expect(layout.snapshot.sidebar.order).toContain('singleton:commit');
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

	it('does not let an older frame retry reclaim focus after another presentation opens', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({
			surfaceFrames: frames,
			initialMainSurfaceId: 'singleton:git',
		});
		const gitAttachment = deferred<void>();
		const attachGit = vi.fn(() => gitAttachment.promise);
		const focusGit = vi.fn();
		const retry = coordinator.retryPresentation('singleton:git', 'main');
		await vi.waitFor(() => expect(coordinator.frameVersion('singleton:git')).toBe(1));
		frames.register('singleton:git', 'main', {
			element: document.createElement('div'),
			attachRetainedRenderer: attachGit,
			focusPrimary: focusGit,
		});
		await vi.waitFor(() => expect(attachGit).toHaveBeenCalledOnce());

		const focusFiles = vi.fn();
		const openSidebar = coordinator.openSidebar();
		await vi.waitFor(() => expect(layout.snapshot.sidebarOpen).toBe(true));
		frames.register('singleton:files', 'sidebar', {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary: focusFiles,
		});
		await openSidebar;
		expect(coordinator.lastFocusedSurfaceId).toBe('singleton:files');
		expect(focusFiles).toHaveBeenCalledOnce();

		gitAttachment.resolve();
		await retry;

		expect(focusGit).not.toHaveBeenCalled();
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
		await vi.waitFor(() =>
			expect(layout.snapshot.main.activeId).toBe('singleton:pull-requests'),
		);
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

	it('moves between tabs in the focused host without wrapping at either boundary', async () => {
		const { coordinator, layout } = createHarness();
		coordinator.focusOwner = { kind: 'surface', surfaceId: CHAT_SURFACE_ID };

		expect(coordinator.focusPreviousTabInFocusedHost()).toBe(true);
		expect(layout.snapshot.main.activeId).toBe(CHAT_SURFACE_ID);
		expect(coordinator.focusNextTabInFocusedHost()).toBe(true);
		await vi.waitFor(() => expect(layout.snapshot.main.activeId).toBe('singleton:git'));

		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:git' };
		expect(coordinator.focusNextTabInFocusedHost()).toBe(true);
		await vi.waitFor(() => expect(layout.snapshot.main.activeId).toBe('singleton:pull-requests'));
		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:pull-requests' };
		expect(coordinator.focusNextTabInFocusedHost()).toBe(true);
		expect(layout.snapshot.main.activeId).toBe('singleton:pull-requests');

		await coordinator.focusSurface('singleton:files');
		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:files' };
		expect(coordinator.focusPreviousTabInFocusedHost()).toBe(true);
		expect(layout.snapshot.sidebar.activeId).toBe('singleton:files');
		expect(coordinator.focusNextTabInFocusedHost()).toBe(true);
		await vi.waitFor(() => expect(layout.snapshot.sidebar.activeId).toBe('singleton:commit'));
		expect(layout.snapshot.main.activeId).toBe('singleton:pull-requests');
	});

	it('toggles focus between active main and sidebar surfaces only while the sidebar is open', async () => {
		const { coordinator } = createHarness();
		const focusSurface = vi.spyOn(coordinator, 'focusSurface').mockResolvedValue();

		coordinator.toggleFocusBetweenMainAndSidebar();
		expect(focusSurface).not.toHaveBeenCalled();

		await coordinator.openSidebar();
		coordinator.focusOwner = { kind: 'surface', surfaceId: CHAT_SURFACE_ID };
		coordinator.toggleFocusBetweenMainAndSidebar();
		expect(focusSurface).toHaveBeenLastCalledWith('singleton:files');

		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:files' };
		coordinator.toggleFocusBetweenMainAndSidebar();
		expect(focusSurface).toHaveBeenLastCalledWith(CHAT_SURFACE_ID);
	});

	it('does not navigate host tabs from the chat list or mobile presentation', async () => {
		const { coordinator, appShell, layout } = createHarness();
		coordinator.focusOwner = { kind: 'chat-list' };
		expect(coordinator.focusNextTabInFocusedHost()).toBe(false);
		expect(layout.snapshot.main.activeId).toBe(CHAT_SURFACE_ID);

		appShell.isMobile = true;
		await coordinator.enterMobilePresentation();
		coordinator.focusOwner = { kind: 'surface', surfaceId: CHAT_SURFACE_ID };
		expect(coordinator.focusNextTabInFocusedHost()).toBe(false);
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(CHAT_SURFACE_ID);
	});

	it('switches a terminal tab in place and swaps an already placed target', async () => {
		const { coordinator, layout, terminals } = createHarness();
		for (const terminalId of ['one', 'two']) {
			terminals.sessions[terminalId] = {
				metadata: terminalMetadata(terminalId),
				attachmentState: 'attached',
			};
		}
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface',
					surface: { id: terminalSurfaceId('one'), type: 'terminal', terminalId: 'one' },
					host: 'main',
				},
				{ type: 'focus-host', host: 'main', surfaceId: terminalSurfaceId('one') },
				{
					type: 'register-surface',
					surface: { id: terminalSurfaceId('two'), type: 'terminal', terminalId: 'two' },
					host: 'sidebar',
				},
				{ type: 'focus-host', host: 'sidebar', surfaceId: terminalSurfaceId('two') },
			]),
		);

		await coordinator.switchTerminalSurface('one', 'two');

		expect(layout.snapshot.main.activeId).toBe(terminalSurfaceId('two'));
		expect(layout.snapshot.sidebar.activeId).toBe(terminalSurfaceId('one'));
		expect(layout.snapshot.main.order.filter((id) => id.startsWith('terminal:'))).toHaveLength(1);
		expect(layout.snapshot.sidebar.order.filter((id) => id.startsWith('terminal:'))).toHaveLength(
			1,
		);
	});

	it('replaces a terminal tab with an unplaced live session', async () => {
		const { coordinator, layout, terminals } = createHarness();
		for (const terminalId of ['one', 'two']) {
			terminals.sessions[terminalId] = {
				metadata: terminalMetadata(terminalId),
				attachmentState: 'attached',
			};
		}
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface',
					surface: { id: terminalSurfaceId('one'), type: 'terminal', terminalId: 'one' },
					host: 'main',
				},
				{ type: 'focus-host', host: 'main', surfaceId: terminalSurfaceId('one') },
			]),
		);

		await coordinator.switchTerminalSurface('one', 'two');

		expect(layout.snapshot.main.activeId).toBe(terminalSurfaceId('two'));
		expect(layout.snapshot.surfaces[terminalSurfaceId('one')]).toBeUndefined();
		expect(layout.snapshot.unplacedTerminalIds).toContain('one');
		expect(layout.snapshot.unplacedTerminalIds).not.toContain('two');
		expect(terminals.sessions.one).toBeDefined();
	});

	it('creates a terminal by replacing the current tab without closing the prior session', async () => {
		const { coordinator, layout, terminals } = createHarness();
		terminals.sessions.one = {
			metadata: terminalMetadata('one'),
			attachmentState: 'attached',
		};
		terminals.create.mockResolvedValue('two');
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface',
					surface: { id: terminalSurfaceId('one'), type: 'terminal', terminalId: 'one' },
					host: 'main',
				},
				{ type: 'focus-host', host: 'main', surfaceId: terminalSurfaceId('one') },
			]),
		);

		await coordinator.createTerminalReplacing('one', 'terminal-surface:one:main');

		expect(layout.snapshot.main.activeId).toBe(terminalSurfaceId('two'));
		expect(layout.snapshot.main.order).not.toContain(terminalSurfaceId('one'));
		expect(layout.snapshot.main.order.filter((id) => id.startsWith('terminal:'))).toHaveLength(1);
		expect(layout.snapshot.unplacedTerminalIds).toContain('one');
		expect(terminals.sessions.one).toBeDefined();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
	});

	it('opens the first closed sidebar default without moving an existing surface', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.moveSurface('singleton:files', 'main');
		await coordinator.closeSurface('singleton:commit');

		await coordinator.openSidebar();

		expect(layout.snapshot.sidebarOpen).toBe(true);
		expect(layout.snapshot.sidebar.order).toEqual(['singleton:commit']);
		expect(layout.snapshot.sidebar.activeId).toBe('singleton:commit');
		expect(layout.snapshot.main.order).toContain('singleton:files');
	});

	it('does not offer an empty sidebar when every default is already placed', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.moveSurface('singleton:files', 'main');
		await coordinator.moveSurface('singleton:commit', 'main');

		expect(coordinator.canOpenSidebar).toBe(false);
		await coordinator.openSidebar();

		expect(layout.snapshot.sidebarOpen).toBe(false);
		expect(layout.snapshot.sidebar.order).toEqual([]);
	});

	it('coalesces concurrent singleton opens into one placement', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.closeSurface('singleton:commit');

		await Promise.all([
			coordinator.openSingleton('commit', 'sidebar'),
			coordinator.openSingleton('commit', 'sidebar'),
		]);

		expect(layout.snapshot.sidebar.order.filter((id) => id === 'singleton:commit')).toHaveLength(1);
		expect(layout.snapshot.sidebar.activeId).toBe('singleton:commit');
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

	it('recovers every live terminal when no terminal placement survived restoration', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.reconcileTerminals(['one', 'two'], { deriveLauncher: false });

		expect(layout.snapshot.main.order).toContain(terminalSurfaceId('one'));
		expect(layout.snapshot.main.order).toContain(terminalSurfaceId('two'));
		expect(layout.snapshot.main.activeId).toBe(CHAT_SURFACE_ID);
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

	it('removes the launcher when New Terminal is invoked elsewhere without recording dismissal', async () => {
		const onTerminalLauncherDismissed = vi.fn();
		const { coordinator, terminals, layout } = createHarness({ onTerminalLauncherDismissed });
		await coordinator.reconcileTerminals([], { deriveLauncher: true });
		terminals.create.mockResolvedValue('terminal-sidebar');

		await coordinator.createTerminal('sidebar');

		expect(layout.surface('terminal-launcher')).toBeNull();
		expect(layout.snapshot.sidebar.order).toContain(terminalSurfaceId('terminal-sidebar'));
		expect(onTerminalLauncherDismissed).not.toHaveBeenCalled();
	});

	it('terminates a newly created terminal when its placement cannot publish', async () => {
		const { coordinator, terminals, layout } = createHarness({ failLayoutPublishAt: 1 });
		terminals.create.mockResolvedValue('terminal-unplaced');

		await expect(coordinator.createTerminal('main')).rejects.toThrow('layout publication failed');

		expect(terminals.requestTermination).toHaveBeenCalledWith(
			'terminal-unplaced',
			expect.any(String),
		);
		expect(terminals.disposeTerminatedSession).toHaveBeenCalledWith('terminal-unplaced');
		expect(layout.surface(terminalSurfaceId('terminal-unplaced'))).toBeNull();
	});

	it('keeps the launcher and terminates its terminal when replacement cannot publish', async () => {
		const { coordinator, terminals, layout } = createHarness({ failLayoutPublishAt: 2 });
		await coordinator.reconcileTerminals([], { deriveLauncher: true });
		terminals.create.mockResolvedValue('terminal-unplaced');

		await expect(coordinator.activateTerminalLauncher('main')).rejects.toThrow(
			'layout publication failed',
		);

		expect(layout.snapshot.main.order).toContain('terminal-launcher');
		expect(layout.surface(terminalSurfaceId('terminal-unplaced'))).toBeNull();
		expect(terminals.requestTermination).toHaveBeenCalledWith(
			'terminal-unplaced',
			expect.any(String),
		);
		expect(terminals.disposeTerminatedSession).toHaveBeenCalledWith('terminal-unplaced');
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

		await expect(coordinator.terminateTerminalSession(terminalId)).rejects.toThrow('network lost');
		expect(layout.surface(surfaceId)).not.toBeNull();
		await expect(coordinator.terminateTerminalSession(terminalId)).resolves.toBe(true);

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

		await expect(coordinator.terminateTerminalSession(terminalId)).resolves.toBe(true);

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

		await expect(coordinator.terminateTerminalSession(terminalId)).resolves.toBe(true);

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
