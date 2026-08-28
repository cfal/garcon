import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceLayoutStore, reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { ChatInteractionGate } from '../chat-interaction-gate.svelte';
import { TransientLayerRegistry } from '../transient-layers.svelte';
import { WorkspaceCoordinator, WorkspacePaneLimitError } from '../workspace-coordinator.svelte';
import { WorkspaceTransitionArbiter } from '../workspace-transition-arbiter';
import {
	CHAT_SURFACE_ID,
	fileSurfaceId,
	terminalSurfaceId,
	type PaneId,
} from '../surface-types';
import { paneIdOfSurface, paneNodeById, collectPaneNodes } from '../pane-tree';
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

function paneTabs(snapshot: WorkspaceLayoutSnapshot, paneId: string) {
	const pane = paneNodeById(snapshot.desktopRoot, paneId as PaneId);
	if (!pane) throw new Error(`Pane missing in test: ${paneId}`);
	return pane.tabs;
}

function paneCountOf(snapshot: WorkspaceLayoutSnapshot): number {
	return collectPaneNodes(snapshot.desktopRoot).length;
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
		initialActiveSurfaceId?: string;
		onLayoutChanged?: () => void;
		onTerminalLauncherDismissed?: () => void;
		failLayoutPublishAt?: number;
	} = {},
) {
	const layout = createWorkspaceLayoutStore();
	if (options.initialActiveSurfaceId) {
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'activate-pane-tab',
					paneId: 'pane-main',
					surfaceId: options.initialActiveSurfaceId,
				},
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
	const appShell = { isMobile: false, requestComposerFocus: vi.fn() };
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
	it('places a file as a tab in the target pane', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.placeFileSession('pane-file', { type: 'pane', paneId: 'pane-main' });

		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(fileSurfaceId('pane-file'));
		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(fileSurfaceId('pane-file'));
	});

	it('rolls back the publication when file placement fails to publish', async () => {
		const { coordinator, layout, chatInteractionGate } = createHarness({
			failLayoutPublishAt: 1,
		});
		const publication = { publish: vi.fn(), rollback: vi.fn() };

		await expect(
			coordinator.placeFileSession('failed-file', { type: 'pane', paneId: 'pane-main' }, publication),
		).rejects.toThrow('layout publication failed');

		expect(publication.publish).toHaveBeenCalledOnce();
		expect(publication.rollback).toHaveBeenCalledOnce();
		expect(chatInteractionGate.isChatDropEligible).toBe(true);
		expect(layout.surface(fileSurfaceId('failed-file'))).toBeNull();
	});

	it('places a file into a new pane split from the anchor', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.placeFileSession('split-file', { type: 'new-pane', anchorPaneId: 'pane-main' });

		expect(paneCountOf(layout.snapshot)).toBe(2);
		const paneId = paneIdOfSurface(layout.snapshot.desktopRoot, fileSurfaceId('split-file'));
		expect(paneId).not.toBe('pane-main');
		expect(paneTabs(layout.snapshot, paneId!).activeId).toBe(fileSurfaceId('split-file'));
	});

	it('falls back to a live pane when a file destination collapses before placement', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;

		const closing = coordinator.closeSurface('singleton:git-history');
		const placing = coordinator.placeFileSession('stale-pane', {
			type: 'pane',
			paneId: historyPaneId,
		});
		await Promise.all([closing, placing]);

		expect(paneIdOfSurface(layout.snapshot.desktopRoot, fileSurfaceId('stale-pane'))).toBe(
			'pane-main',
		);
	});

	it('toggles fullscreen for a pane', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.toggleFullscreen('pane-main');
		expect(layout.snapshot.fullscreenPaneId).toBe('pane-main');
		await coordinator.toggleFullscreen('pane-main');
		expect(layout.snapshot.fullscreenPaneId).toBeNull();
	});

	it('exits fullscreen when focus moves to another pane', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		await coordinator.toggleFullscreen('pane-main');

		expect(layout.snapshot.fullscreenPaneId).toBe('pane-main');
		await coordinator.focusSurface('singleton:git-history');
		expect(layout.snapshot.fullscreenPaneId).toBeNull();
		expect(paneTabs(layout.snapshot, historyPaneId).activeId).toBe('singleton:git-history');
	});

	it('clears fullscreen when the fullscreen pane collapses', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		await coordinator.toggleFullscreen(historyPaneId);
		expect(layout.snapshot.fullscreenPaneId).toBe(historyPaneId);

		await coordinator.closeSurface('singleton:git-history');
		expect(layout.snapshot.fullscreenPaneId).toBeNull();
		expect(paneCountOf(layout.snapshot)).toBe(1);
	});

	it('falls back from a collapsed last-focused pane', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		expect(coordinator.lastFocusedPaneId).toBe(historyPaneId);

		await coordinator.closeSurface('singleton:git-history');

		expect(coordinator.lastFocusedPaneId).toBe('pane-main');
	});

	it('cancels Chat interaction before fullscreen and restores state on publish failure', async () => {
		const successful = createHarness();
		const cancel = vi.spyOn(successful.chatInteractionGate, 'cancelBeforeInertTransition');
		await successful.coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(
			successful.layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		await successful.coordinator.toggleFullscreen(historyPaneId);
		expect(cancel).toHaveBeenCalled();
		expect(successful.coordinator.isChatPresented).toBe(false);

		const failed = createHarness({ failLayoutPublishAt: 1 });
		await expect(failed.coordinator.toggleFullscreen('pane-main')).rejects.toThrow(
			'layout publication failed',
		);
		expect(failed.layout.snapshot.fullscreenPaneId).toBeNull();
		expect(failed.coordinator.isChatPresented).toBe(true);
		expect(failed.chatInteractionGate.isChatDropEligible).toBe(true);
	});

	it('computes rapid fullscreen toggles from the latest committed snapshot', async () => {
		const { coordinator, layout } = createHarness();

		await Promise.all([
			coordinator.toggleFullscreen('pane-main'),
			coordinator.toggleFullscreen('pane-main'),
		]);

		expect(layout.snapshot.fullscreenPaneId).toBeNull();
	});

	it('places files in the mobile-only presentation regardless of a desktop target', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.enterMobilePresentation();

		await coordinator.placeFileSession('mobile-file', { type: 'pane', paneId: 'pane-main' });

		const surfaceId = fileSurfaceId('mobile-file');
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(surfaceId);
		expect(layout.snapshot.mobileOnlySurfaceIds).toContain(surfaceId);
		expect(layout.snapshot.dialogFileSurfaceId).toBeNull();
		expect(paneIdOfSurface(layout.snapshot.desktopRoot, surfaceId)).toBeNull();
	});

	it('destroys a mobile file session and returns to Chat when it is closed', async () => {
		const confirmDestructive = vi.fn(async () => true);
		const { coordinator, files, layout } = createHarness({ confirmDestructive });
		await coordinator.enterMobilePresentation();
		await coordinator.placeFileSession('mobile-file');
		const surfaceId = fileSurfaceId('mobile-file');

		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

		expect(confirmDestructive).toHaveBeenCalledWith('mobile-file', 'close');
		expect(files.destroy).toHaveBeenCalledWith('mobile-file');
		expect(layout.surface(surfaceId)).toBeNull();
		expect(layout.snapshot.mobileOnlySurfaceIds).not.toContain(surfaceId);
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(CHAT_SURFACE_ID);
	});

	it('keeps a dirty mobile file visible when destructive Close is cancelled', async () => {
		const confirmDestructive = vi.fn(async () => false);
		const { coordinator, files, layout } = createHarness({ confirmDestructive });
		await coordinator.enterMobilePresentation();
		await coordinator.placeFileSession('mobile-file');
		const surfaceId = fileSurfaceId('mobile-file');

		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(false);

		expect(confirmDestructive).toHaveBeenCalledWith('mobile-file', 'close');
		expect(files.destroy).not.toHaveBeenCalled();
		expect(layout.surface(surfaceId)).not.toBeNull();
		expect(layout.snapshot.mobileOnlySurfaceIds).toContain(surfaceId);
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(surfaceId);
	});

	it('serializes dialog replacements without stacking and revalidates each occupant', async () => {
		const firstConfirmation = deferred<boolean>();
		const secondConfirmation = deferred<boolean>();
		const confirmations = [firstConfirmation, secondConfirmation];
		const confirmDestructive = vi.fn(() => confirmations.shift()!.promise);
		const { coordinator, files, layout } = createHarness({ confirmDestructive });
		await coordinator.placeFileSession('one', { type: 'dialog' });

		const second = coordinator.placeFileSession('two', { type: 'dialog' });
		const third = coordinator.placeFileSession('three', { type: 'dialog' });
		await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledTimes(1));
		firstConfirmation.resolve(true);
		await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledTimes(2));
		secondConfirmation.resolve(true);

		await expect(second).resolves.toBe('placed');
		await expect(third).resolves.toBe('placed');
		expect(layout.snapshot.dialogFileSurfaceId).toBe(fileSurfaceId('three'));
		expect(files.destroy).toHaveBeenNthCalledWith(1, 'one');
		expect(files.destroy).toHaveBeenNthCalledWith(2, 'two');
	});

	it('cancels a pending dialog replacement when responsive presentation changes', async () => {
		const confirmation = deferred<boolean>();
		const confirmDestructive = vi.fn(() => confirmation.promise);
		const { coordinator, layout, appShell } = createHarness({ confirmDestructive });
		await coordinator.placeFileSession('one', { type: 'dialog' });
		const replacement = coordinator.placeFileSession('two', { type: 'dialog' });
		await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledOnce());

		appShell.isMobile = true;
		await coordinator.enterMobilePresentation();
		confirmation.resolve(true);

		await expect(replacement).resolves.toBe('cancelled');
		expect(layout.snapshot.dialogFileSurfaceId).toBe(fileSurfaceId('one'));
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(fileSurfaceId('one'));
		expect(layout.surface(fileSurfaceId('two'))).toBeNull();
	});

	it('rejects moving a dialog file into a pane that collapsed before publication', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.placeFileSession('dialog-stale-pane', { type: 'dialog' });
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;

		const closing = coordinator.closeSurface('singleton:git-history');
		const moving = coordinator.moveDialogFileToPane(historyPaneId);
		await closing;

		await expect(moving).rejects.toThrow('destination pane is no longer available');
		expect(layout.snapshot.dialogFileSurfaceId).toBe(fileSurfaceId('dialog-stale-pane'));
	});

	it('closes a terminal tab without terminating its session and can reopen it', async () => {
		const { coordinator, layout, terminals } = createHarness();
		const terminalId = 'terminal-unplaced';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'pane-main');
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

		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		await coordinator.openTerminalSession(terminalId, historyPaneId);
		expect(paneTabs(layout.snapshot, historyPaneId).order).toContain(surfaceId);
		expect(layout.snapshot.unplacedTerminalIds).not.toContain(terminalId);
	});

	it('rejects tab moves while explicit terminal termination owns the destructive reservation', async () => {
		const termination = deferred<void>();
		const terminate = vi.fn(() => termination.promise);
		const { coordinator, layout, terminals } = createHarness({ terminate });
		const terminalId = 'terminal-1';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'pane-main');
		const surfaceId = terminalSurfaceId(terminalId);

		const terminationRequest = coordinator.terminateTerminalSession(terminalId);
		expect(coordinator.closeGuardRequest?.surfaceId).toBe(surfaceId);
		coordinator.resolveCloseGuard(true);
		await Promise.resolve();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		await coordinator.moveTabToPane(surfaceId, historyPaneId);
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(surfaceId);
		expect(paneTabs(layout.snapshot, historyPaneId).order).not.toContain(surfaceId);

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
		await coordinator.openTerminalSession(terminalId, 'pane-main');
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
		await coordinator.openTerminalSession(terminalId, 'pane-main');
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
		await coordinator.placeFileSession('saving', { type: 'pane', paneId: 'pane-main' });
		await coordinator.openSingletonAsTab('commit', 'pane-main');

		expect(coordinator.isSurfaceCloseBlocked(fileSurfaceId('saving'))).toBe(true);
		expect(coordinator.isSurfaceCloseBlocked('singleton:commit')).toBe(true);
		await expect(coordinator.closeSurface(fileSurfaceId('saving'))).resolves.toBe(false);
		await expect(coordinator.closeSurface('singleton:commit')).resolves.toBe(false);
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(fileSurfaceId('saving'));
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain('singleton:commit');
	});

	it('blocks the invoking Git singleton while its branch mutation is pending', async () => {
		const { coordinator } = createHarness({ pendingGitSurfaceIds: ['singleton:git'] });

		expect(coordinator.isSurfaceCloseBlocked('singleton:git')).toBe(true);
		await expect(coordinator.closeSurface('singleton:git')).resolves.toBe(false);
	});

	it('exits a concurrently enabled fullscreen when a tab moves to another pane', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;

		const enableFullscreen = coordinator.toggleFullscreen('pane-main');
		const move = coordinator.moveTabToPane('singleton:git', historyPaneId);
		await Promise.all([enableFullscreen, move]);

		expect(layout.snapshot.fullscreenPaneId).toBeNull();
		expect(paneTabs(layout.snapshot, historyPaneId).order).toContain('singleton:git');
		expect(paneTabs(layout.snapshot, historyPaneId).activeId).toBe('singleton:git');
	});

	it('publishes placement before awaiting the exact destination frame', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const opening = coordinator.openSingletonAsTab('files', 'pane-main');
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:files'),
		);
		expect(coordinator.frameVersion('singleton:files')).toBe(1);

		const attachRetainedRenderer = vi.fn();
		frames.register('singleton:files', 'pane-main', {
			element: document.createElement('div'),
			attachRetainedRenderer,
			focusPrimary: vi.fn(),
		});
		await opening;

		expect(attachRetainedRenderer).toHaveBeenCalledOnce();
		expect(coordinator.attachmentErrors['singleton:files']).toBeUndefined();
	});

	it('reveals a retained renderer before retrying an attachment error', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const opening = coordinator.openSingletonAsTab('files', 'pane-main');
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:files'),
		);
		const failedBridge = new SurfaceFrameBridge();
		const failedActivation = vi.fn(() => failedBridge.activate());
		frames.register('singleton:files', 'pane-main', {
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
		expect(coordinator.attachmentErrors['singleton:files']).toBe('renderer failed');

		failedBridge.deactivate();
		const retry = coordinator.retryPresentation('singleton:files', 'pane-main');
		expect(coordinator.attachmentErrors['singleton:files']).toBeUndefined();
		await vi.waitFor(() => expect(coordinator.frameVersion('singleton:files')).toBe(2));
		const retryBridge = new SurfaceFrameBridge();
		const attachRetainedRenderer = vi.fn(() => retryBridge.activate());
		frames.register('singleton:files', 'pane-main', {
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

		expect(coordinator.attachmentErrors['singleton:files']).toBeUndefined();
	});

	it('does not let an older frame retry reclaim focus after another presentation opens', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({
			surfaceFrames: frames,
			initialActiveSurfaceId: 'singleton:git',
		});
		const gitAttachment = deferred<void>();
		const attachGit = vi.fn(() => gitAttachment.promise);
		const focusGit = vi.fn();
		const retry = coordinator.retryPresentation('singleton:git', 'pane-main');
		await vi.waitFor(() => expect(coordinator.frameVersion('singleton:git')).toBe(1));
		frames.register('singleton:git', 'pane-main', {
			element: document.createElement('div'),
			attachRetainedRenderer: attachGit,
			focusPrimary: focusGit,
		});
		await vi.waitFor(() => expect(attachGit).toHaveBeenCalledOnce());

		const focusPullRequests = vi.fn();
		const focusNext = coordinator.focusSurface('singleton:pull-requests');
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:pull-requests'),
		);
		frames.register('singleton:pull-requests', 'pane-main', {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary: focusPullRequests,
		});
		await focusNext;
		expect(coordinator.lastFocusedSurfaceId).toBe('singleton:pull-requests');
		expect(focusPullRequests).toHaveBeenCalledOnce();

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
		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:git' };
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

	it.each(['git-history', 'git-compare'] as const)(
		'closes mobile-only %s and returns to Chat',
		async (kind) => {
			const { coordinator, layout, singletons } = createHarness();
			await coordinator.enterMobilePresentation();
			await coordinator.focusMobileSingleton(kind);
			const surfaceId = `singleton:${kind}`;

			expect(layout.snapshot.mobileActiveSurfaceId).toBe(surfaceId);
			expect(layout.snapshot.mobileOnlySurfaceIds).toContain(surfaceId);
			await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

			expect(layout.surface(surfaceId)).toBeNull();
			expect(layout.snapshot.mobileActiveSurfaceId).toBe(CHAT_SURFACE_ID);
			expect(singletons.disposeSurface).toHaveBeenCalledWith(kind);
		},
	);

	it('destroys every mobile-only Git view on responsive desktop return', async () => {
		const { coordinator, layout, singletons } = createHarness();
		await coordinator.enterMobilePresentation();
		await coordinator.focusMobileSingleton('git-history');
		await coordinator.focusMobileSingleton('git-compare');

		await coordinator.exitMobilePresentation();

		expect(coordinator.isMobile).toBe(false);
		expect(layout.surface('singleton:git-history')).toBeNull();
		expect(layout.surface('singleton:git-compare')).toBeNull();
		expect(singletons.disposeSurface).toHaveBeenCalledWith('git-history');
		expect(singletons.disposeSurface).toHaveBeenCalledWith('git-compare');
	});

	it('disposes a removed Git view when mobile re-entry supersedes desktop reconciliation', async () => {
		const context: {
			coordinator?: WorkspaceCoordinator;
			layout?: ReturnType<typeof createWorkspaceLayoutStore>;
		} = {};
		let reentry: Promise<void> | null = null;
		let triggerReentry = false;
		const harness = createHarness({
			onLayoutChanged: () => {
				if (triggerReentry && !context.layout?.surface('singleton:git-compare') && !reentry) {
					reentry = context.coordinator?.enterMobilePresentation() ?? null;
				}
			},
		});
		context.coordinator = harness.coordinator;
		context.layout = harness.layout;
		await harness.coordinator.enterMobilePresentation();
		await harness.coordinator.focusMobileSingleton('git-compare');
		triggerReentry = true;

		await harness.coordinator.exitMobilePresentation();
		await reentry;

		expect(harness.coordinator.isMobile).toBe(true);
		expect(harness.layout.surface('singleton:git-compare')).toBeNull();
		expect(harness.singletons.disposeSurface).toHaveBeenCalledWith('git-compare');
	});

	it('preserves a desktop-owned Git view across a mobile presentation', async () => {
		const { coordinator, layout, singletons } = createHarness();
		await coordinator.openSingletonAsTab('git-history', 'pane-main');
		await coordinator.enterMobilePresentation();
		await coordinator.focusMobileSingleton('git-history');

		await coordinator.exitMobilePresentation();

		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain('singleton:git-history');
		expect(layout.surface('singleton:git-history')).not.toBeNull();
		expect(singletons.disposeSurface).not.toHaveBeenCalledWith('git-history');
	});

	it('rolls back a failed desktop return and remains retryable', async () => {
		const { coordinator, layout } = createHarness({ failLayoutPublishAt: 4 });
		await coordinator.enterMobilePresentation();
		await coordinator.focusMobileSingleton('git-history');

		await expect(coordinator.exitMobilePresentation()).rejects.toThrow('layout publication failed');
		expect(coordinator.isMobile).toBe(true);
		expect(layout.surface('singleton:git-history')).not.toBeNull();

		await expect(coordinator.exitMobilePresentation()).resolves.toBeUndefined();
		expect(coordinator.isMobile).toBe(false);
		expect(layout.surface('singleton:git-history')).toBeNull();
	});

	it('prepares a queued commit for the presentation mode active in its arbiter turn', async () => {
		const { coordinator, singletons } = createHarness();

		const enterMobile = coordinator.enterMobilePresentation();
		const queuedFocus = coordinator.focusSurface('singleton:git');
		await Promise.all([enterMobile, queuedFocus]);

		expect(coordinator.isMobile).toBe(true);
		const gitVisibility = singletons.setPresentationVisible.mock.calls.filter(
			([kind]) => kind === 'git',
		);
		expect(gitVisibility.at(-1)).toEqual(['git', false]);
	});

	it('does not route shortcuts through a stale hidden surface owner', () => {
		const { coordinator, transientLayers, appShell, files } = createHarness();
		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:pull-requests' };
		const dispatcher = new WorkspaceShortcutDispatcher({
			workspace: coordinator,
			transients: transientLayers,
			appShell: appShell as never,
			navigation: {} as never,
			files: files as never,
			localSettings: { globalShortcuts: {} },
		});
		const handler = vi.fn(() => true);
		dispatcher.registerSurface('singleton:pull-requests', handler);

		dispatcher.handle(new KeyboardEvent('keydown', { key: 'x' }));

		expect(handler).not.toHaveBeenCalled();
	});

	it('initializes Chat drop eligibility from the restored presentation', () => {
		const { chatInteractionGate } = createHarness({
			initialActiveSurfaceId: 'singleton:git',
		});

		expect(chatInteractionGate.isChatDropEligible).toBe(false);
	});

	it('does not restore focus or recency after a presentation is superseded', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const focusGit = coordinator.focusSurface('singleton:git');
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:git'),
		);

		const focusPullRequests = coordinator.focusSurface('singleton:pull-requests');
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:pull-requests'),
		);
		const focusPrimary = vi.fn();
		frames.register('singleton:pull-requests', 'pane-main', {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary,
		});

		await Promise.all([focusGit, focusPullRequests]);
		expect(coordinator.lastFocusedSurfaceId).toBe('singleton:pull-requests');
		expect(focusPrimary).toHaveBeenCalledOnce();
	});

	it('reports a published file as placed when its presentation is superseded', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const surfaceId = fileSurfaceId('superseded');
		const placement = coordinator.placeFileSession('superseded', {
			type: 'pane',
			paneId: 'pane-main',
		});
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(surfaceId),
		);

		const focusGit = coordinator.focusSurface('singleton:git');
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:git'),
		);
		frames.register('singleton:git', 'pane-main', {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary: vi.fn(),
		});

		await expect(placement).resolves.toBe('placed');
		await focusGit;
		expect(layout.surface(surfaceId)).not.toBeNull();
	});

	it('focuses an existing surface by activating its pane tab', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonAsTab('files', 'pane-main');
		await coordinator.focusChat();
		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(CHAT_SURFACE_ID);

		await coordinator.focusSurface('singleton:files');

		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:files');
	});

	it('requests composer focus when Chat becomes the focused surface', async () => {
		const { coordinator, appShell } = createHarness({ initialActiveSurfaceId: 'singleton:git' });

		await coordinator.focusChat();

		expect(appShell.requestComposerFocus).toHaveBeenCalledOnce();
	});

	it('moves between tabs in the focused pane without wrapping at either boundary', async () => {
		const { coordinator, layout } = createHarness();
		coordinator.focusOwner = { kind: 'surface', surfaceId: CHAT_SURFACE_ID };

		expect(coordinator.focusPreviousTabInFocusedPane()).toBe(true);
		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(CHAT_SURFACE_ID);
		expect(coordinator.focusNextTabInFocusedPane()).toBe(true);
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:git'),
		);

		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:git' };
		expect(coordinator.focusNextTabInFocusedPane()).toBe(true);
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:pull-requests'),
		);
		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:pull-requests' };
		expect(coordinator.focusNextTabInFocusedPane()).toBe(true);
		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:pull-requests');
	});

	it('cycles focus across panes with the pane focus shortcut', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const focusSurface = vi.spyOn(coordinator, 'focusSurface').mockResolvedValue();
		coordinator.focusOwner = { kind: 'surface', surfaceId: CHAT_SURFACE_ID };

		coordinator.cyclePaneFocus();
		expect(focusSurface).toHaveBeenLastCalledWith('singleton:git-history');

		coordinator.cyclePaneFocus({ kind: 'surface', surfaceId: 'singleton:git-history' });
		expect(focusSurface).toHaveBeenLastCalledWith(CHAT_SURFACE_ID);
		expect(layout.snapshot.fullscreenPaneId).toBeNull();
	});

	it('does not navigate pane tabs from the chat list or mobile presentation', async () => {
		const { coordinator, appShell, layout } = createHarness();
		coordinator.focusOwner = { kind: 'chat-list' };
		expect(coordinator.focusNextTabInFocusedPane()).toBe(false);
		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(CHAT_SURFACE_ID);

		appShell.isMobile = true;
		await coordinator.enterMobilePresentation();
		coordinator.focusOwner = { kind: 'surface', surfaceId: CHAT_SURFACE_ID };
		expect(coordinator.focusNextTabInFocusedPane()).toBe(false);
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
					type: 'split-tab-to-edge',
					surfaceId: 'singleton:git',
					targetPaneId: 'pane-main',
					edge: 'right',
					newPaneId: 'pane-2',
					splitId: 'split-1',
				},
				{
					type: 'register-surface',
					surface: { id: terminalSurfaceId('one'), type: 'terminal', terminalId: 'one' },
					paneId: 'pane-main',
				},
				{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: terminalSurfaceId('one') },
				{
					type: 'register-surface',
					surface: { id: terminalSurfaceId('two'), type: 'terminal', terminalId: 'two' },
					paneId: 'pane-2',
				},
			]),
		);

		await coordinator.switchTerminalSurface('one', 'two');

		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(terminalSurfaceId('two'));
		expect(paneTabs(layout.snapshot, 'pane-2').order).toContain(terminalSurfaceId('one'));
		expect(
			paneTabs(layout.snapshot, 'pane-main').order.filter((id) => id.startsWith('terminal:')),
		).toHaveLength(1);
		expect(
			paneTabs(layout.snapshot, 'pane-2').order.filter((id) => id.startsWith('terminal:')),
		).toHaveLength(1);
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
					paneId: 'pane-main',
				},
				{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: terminalSurfaceId('one') },
			]),
		);

		await coordinator.switchTerminalSurface('one', 'two');

		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(terminalSurfaceId('two'));
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
					paneId: 'pane-main',
				},
				{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: terminalSurfaceId('one') },
			]),
		);

		await coordinator.createTerminalReplacing('one', 'terminal-surface:one:pane-main');

		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(terminalSurfaceId('two'));
		expect(paneTabs(layout.snapshot, 'pane-main').order).not.toContain(terminalSurfaceId('one'));
		expect(
			paneTabs(layout.snapshot, 'pane-main').order.filter((id) => id.startsWith('terminal:')),
		).toHaveLength(1);
		expect(layout.snapshot.unplacedTerminalIds).toContain('one');
		expect(terminals.sessions.one).toBeDefined();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
	});

	it('opens a singleton in a new pane and focuses it', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.openSingletonInNewPane('git-compare');

		expect(paneCountOf(layout.snapshot)).toBe(2);
		const paneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-compare');
		expect(paneId).not.toBe('pane-main');
		expect(paneTabs(layout.snapshot, paneId!).activeId).toBe('singleton:git-compare');
		expect(coordinator.lastFocusedSurfaceId).toBe('singleton:git-compare');
	});

	it('focuses an existing singleton that already owns a pane instead of splitting again', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-compare');
		const paneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-compare')!;
		await coordinator.focusChat();

		await coordinator.openSingletonInNewPane('git-compare');

		expect(paneCountOf(layout.snapshot)).toBe(2);
		expect(paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-compare')).toBe(paneId);
		expect(coordinator.lastFocusedSurfaceId).toBe('singleton:git-compare');
	});

	it('detaches an existing background singleton into a new pane', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.openSingletonInNewPane('git');

		expect(paneCountOf(layout.snapshot)).toBe(2);
		const paneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git');
		expect(paneId).not.toBe('pane-main');
		expect(paneTabs(layout.snapshot, 'pane-main').order).not.toContain('singleton:git');
	});

	it('rejects new panes beyond the pane limit', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		await coordinator.openSingletonInNewPane('git-compare');
		await coordinator.openSingletonInNewPane('files');
		expect(paneCountOf(layout.snapshot)).toBe(4);

		await expect(coordinator.openSingletonInNewPane('commit')).rejects.toBeInstanceOf(
			WorkspacePaneLimitError,
		);
		expect(layout.surface('singleton:commit')).toBeNull();
	});

	it('coalesces concurrent singleton opens into one placement', async () => {
		const { coordinator, layout } = createHarness();

		await Promise.all([
			coordinator.openSingletonAsTab('commit', 'pane-main'),
			coordinator.openSingletonAsTab('commit', 'pane-main'),
		]);

		expect(
			paneTabs(layout.snapshot, 'pane-main').order.filter((id) => id === 'singleton:commit'),
		).toHaveLength(1);
		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe('singleton:commit');
	});

	it('lets an in-flight close win over a pane-local singleton reopen', async () => {
		const { coordinator, layout, singletons } = createHarness();
		await coordinator.openSingletonAsTab('commit', 'pane-main');

		const closing = coordinator.closeSurface('singleton:commit');
		const reopening = coordinator.openSingletonAsTab('commit', 'pane-main');
		await Promise.all([closing, reopening]);

		expect(layout.surface('singleton:commit')).toBeNull();
		expect(singletons.disposeSurface).toHaveBeenCalledWith('commit');
	});

	it('applies concurrent singleton destinations against the latest layout', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;

		await Promise.all([
			coordinator.openSingletonAsTab('commit', 'pane-main'),
			coordinator.openSingletonAsTab('commit', historyPaneId),
		]);

		expect(paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:commit')).toBe(historyPaneId);
		expect(paneTabs(layout.snapshot, historyPaneId).activeId).toBe('singleton:commit');
	});

	it('allows a net-zero edge move at the pane limit', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		await coordinator.openSingletonInNewPane('git-compare');
		await coordinator.openSingletonInNewPane('files');
		const sourcePaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:files')!;
		expect(paneCountOf(layout.snapshot)).toBe(4);

		await coordinator.splitTabToEdge('singleton:files', 'pane-main', 'left');

		expect(paneCountOf(layout.snapshot)).toBe(4);
		expect(paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:files')).not.toBe(sourcePaneId);
	});

	it('merges a pane into another pane and keeps its tabs', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;

		await coordinator.mergePaneInto(historyPaneId, 'pane-main');

		expect(paneCountOf(layout.snapshot)).toBe(1);
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain('singleton:git-history');
	});

	it('derives the Terminal launcher only while first-run layout is still canonical', async () => {
		const canonical = createHarness();
		await canonical.coordinator.reconcileTerminals([], { deriveLauncher: true });
		expect(paneTabs(canonical.layout.snapshot, 'pane-main').order).toContain('terminal-launcher');

		const changed = createHarness();
		await changed.coordinator.focusSurface('singleton:git');
		await changed.coordinator.reconcileTerminals([], { deriveLauncher: true });
		expect(paneTabs(changed.layout.snapshot, 'pane-main').order).not.toContain(
			'terminal-launcher',
		);
	});

	it('recovers every live terminal when no terminal placement survived restoration', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.reconcileTerminals(['one', 'two'], { deriveLauncher: false });

		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(terminalSurfaceId('one'));
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(terminalSurfaceId('two'));
		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(CHAT_SURFACE_ID);
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

		await expect(coordinator.activateTerminalLauncher('pane-main')).rejects.toThrow('network lost');
		await expect(coordinator.activateTerminalLauncher('pane-main')).resolves.toBeUndefined();

		expect(requestIds[1]).toBe(requestIds[0]);
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(
			terminalSurfaceId('terminal-recovered'),
		);
	});

	it('uses a distinct request ID for each concurrent New Terminal action', async () => {
		const { coordinator, terminals, layout } = createHarness();
		const requestIds: string[] = [];
		terminals.create.mockImplementation(async (_directory: string | null, requestId: string) => {
			requestIds.push(requestId);
			return `terminal-${requestIds.length}`;
		});

		await Promise.all([
			coordinator.createTerminal('pane-main'),
			coordinator.createTerminal('pane-main'),
		]);

		expect(new Set(requestIds).size).toBe(2);
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(
			terminalSurfaceId('terminal-1'),
		);
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(
			terminalSurfaceId('terminal-2'),
		);
	});

	it('removes the launcher when New Terminal is invoked elsewhere without recording dismissal', async () => {
		const onTerminalLauncherDismissed = vi.fn();
		const { coordinator, terminals, layout } = createHarness({ onTerminalLauncherDismissed });
		await coordinator.reconcileTerminals([], { deriveLauncher: true });
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		terminals.create.mockResolvedValue('terminal-other-pane');

		await coordinator.createTerminal(historyPaneId);

		expect(layout.surface('terminal-launcher')).toBeNull();
		expect(paneTabs(layout.snapshot, historyPaneId).order).toContain(
			terminalSurfaceId('terminal-other-pane'),
		);
		expect(onTerminalLauncherDismissed).not.toHaveBeenCalled();
	});

	it('honors the requested pane when reconciliation places a terminal during creation', async () => {
		const creation = deferred<string>();
		const { coordinator, terminals, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		terminals.create.mockReturnValue(creation.promise);

		const opening = coordinator.createTerminal(historyPaneId, `workspace-taskbar:${historyPaneId}`);
		await vi.waitFor(() => expect(terminals.create).toHaveBeenCalledOnce());
		// Simulate a restored live terminal racing the creation.
		await coordinator.handleTerminalSessionTerminated('terminal-race').catch(() => undefined);
		creation.resolve('terminal-race');
		await opening;

		expect(paneTabs(layout.snapshot, historyPaneId).order).toContain(
			terminalSurfaceId('terminal-race'),
		);
		expect(paneTabs(layout.snapshot, historyPaneId).activeId).toBe(
			terminalSurfaceId('terminal-race'),
		);
	});

	it('falls back when a terminal destination collapses during creation', async () => {
		const creation = deferred<string>();
		const { coordinator, terminals, layout } = createHarness();
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		terminals.create.mockReturnValue(creation.promise);

		const opening = coordinator.createTerminal(historyPaneId);
		await vi.waitFor(() => expect(terminals.create).toHaveBeenCalledOnce());
		await coordinator.closeSurface('singleton:git-history');
		creation.resolve('terminal-stale-pane');
		await opening;

		expect(
			paneIdOfSurface(layout.snapshot.desktopRoot, terminalSurfaceId('terminal-stale-pane')),
		).toBe('pane-main');
	});

	it('does not create desktop pane topology when a New Terminal crosses into mobile', async () => {
		const creation = deferred<string>();
		const { coordinator, terminals, layout } = createHarness();
		terminals.create.mockReturnValue(creation.promise);

		const opening = coordinator.createTerminalInNewPane('pane-main');
		await vi.waitFor(() => expect(terminals.create).toHaveBeenCalledOnce());
		await coordinator.enterMobilePresentation();
		creation.resolve('terminal-mobile-transition');
		await opening;

		const surfaceId = terminalSurfaceId('terminal-mobile-transition');
		expect(paneCountOf(layout.snapshot)).toBe(1);
		expect(paneIdOfSurface(layout.snapshot.desktopRoot, surfaceId)).toBe('pane-main');
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(surfaceId);
	});

	it('terminates a newly created terminal when its placement cannot publish', async () => {
		const { coordinator, terminals, layout } = createHarness({ failLayoutPublishAt: 1 });
		terminals.create.mockResolvedValue('terminal-unplaced');

		await expect(coordinator.createTerminal('pane-main')).rejects.toThrow(
			'layout publication failed',
		);

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

		await expect(coordinator.activateTerminalLauncher('pane-main')).rejects.toThrow(
			'layout publication failed',
		);

		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain('terminal-launcher');
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

		const activation = coordinator.activateTerminalLauncher('pane-main');
		await Promise.resolve();
		await coordinator.activateTerminalLauncher('pane-main');
		await coordinator.reconcileTerminals(['terminal-race'], { deriveLauncher: true });

		expect(terminals.create).toHaveBeenCalledOnce();
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain('terminal-launcher');

		creation.resolve('terminal-race');
		await activation;

		expect(paneTabs(layout.snapshot, 'pane-main').order).not.toContain('terminal-launcher');
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(
			terminalSurfaceId('terminal-race'),
		);
		expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(
			terminalSurfaceId('terminal-race'),
		);
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
		await coordinator.openTerminalSession(terminalId, 'pane-main');
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
		await coordinator.openSingletonInNewPane('git-history');
		const historyPaneId = paneIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		await coordinator.openTerminalSession(terminalId, historyPaneId);

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
		const opening = coordinator.openTerminalSession(terminalId, 'pane-main');
		await vi.waitFor(() =>
			expect(paneTabs(layout.snapshot, 'pane-main').activeId).toBe(surfaceId),
		);
		frames.register(surfaceId, 'pane-main', {
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
		await coordinator.openTerminalSession(terminalId, 'pane-main');
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
		await coordinator.placeFileSession('dialog', { type: 'dialog' });
		await coordinator.placeFileSession('source', { type: 'pane', paneId: 'pane-main' });

		const popOut = coordinator.popOutFile(fileSurfaceId('source'));
		await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledOnce());
		await expect(coordinator.closeSurface(fileSurfaceId('source'))).resolves.toBe(false);
		expect(paneTabs(layout.snapshot, 'pane-main').order).toContain(fileSurfaceId('source'));

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
		const open = coordinator.placeFileSession('dialog', { type: 'dialog' });
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
