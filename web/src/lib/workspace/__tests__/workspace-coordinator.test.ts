import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceLayoutStore, reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { WorkspaceInteractionGate } from '../workspace-interaction-gate.svelte';
import { TransientLayerRegistry } from '../transient-layers.svelte';
import { WorkspaceCoordinator } from '../workspace-coordinator.svelte';
import { WorkspaceSplitBlockedError } from '../workspace-split-blocked-error';
import { WorkspaceTransitionArbiter } from '../workspace-transition-arbiter';
import {
	chatViewSurfaceId,
	fileSurfaceId,
	portableSingletonDescriptor,
	terminalSurfaceId,
	type WorkspaceWindowId,
} from '../surface-types';
import { CANONICAL_CHAT_SURFACE_ID, CANONICAL_FILES_SURFACE_ID } from '../canonical-layout';
import { windowIdOfSurface, windowNodeById, collectWindowNodes } from '../window-tree';
import type { TerminalMetadata } from '$shared/terminal';
import type { TerminalAttachmentState } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import { SurfaceFrameRegistry } from '../surface-frame-registry.svelte';
import { SurfaceFrameBridge } from '../surface-frame-context';
import { WorkspaceShortcutDispatcher } from '../workspace-shortcuts';
import type { WorkspaceLayoutSnapshot } from '../surface-types';
import type {
	WorkspacePartitionRatioBoundsResolver,
	WorkspaceSplitAdmissionResolver,
} from '../window-geometry-policy';
import { resolveUnmeasuredWorkspaceSplit } from './workspace-geometry-test-fixtures';
import { WorkspacePresentationController } from '../workspace-presentation-controller.svelte';

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
		title: null,
		initialWorkingDirectory: '/workspace',
		processStatus: 'running',
		attachmentStatus: 'attached',
		createdAt: '2026-07-13T00:00:00.000Z',
		exitCode: null,
		latestOutputSequence: 0,
	};
}

function windowTabs(snapshot: WorkspaceLayoutSnapshot, windowId: string) {
	const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId as WorkspaceWindowId);
	if (!workspaceWindow) throw new Error(`Window missing in test: ${windowId}`);
	return workspaceWindow.tabs;
}

function windowCountOf(snapshot: WorkspaceLayoutSnapshot): number {
	return collectWindowNodes(snapshot.desktopRoot).length;
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
		onLayoutChanged?: (snapshot: WorkspaceLayoutSnapshot) => void;
		onTerminalLauncherDismissed?: () => void;
		failLayoutPublishAt?: number;
		includePortableTabs?: boolean;
		resolveSplitAdmission?: WorkspaceSplitAdmissionResolver;
		resolvePartitionRatioBounds?: WorkspacePartitionRatioBoundsResolver;
	} = {},
) {
	const layout = createWorkspaceLayoutStore();
	if (options.includePortableTabs !== false) {
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface',
					surface: portableSingletonDescriptor('git'),
					windowId: 'window-main',
				},
				{
					type: 'register-surface',
					surface: portableSingletonDescriptor('pull-requests'),
					windowId: 'window-main',
				},
				{
					type: 'activate-window-tab',
					windowId: 'window-main',
					surfaceId: CANONICAL_CHAT_SURFACE_ID,
				},
			]),
		);
	}
	if (options.initialActiveSurfaceId) {
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'activate-window-tab',
					windowId: 'window-main',
					surfaceId: options.initialActiveSurfaceId,
				},
			]),
		);
	}
	const workspaceInteractionGate = new WorkspaceInteractionGate();
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
				attachmentState: TerminalAttachmentState;
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
	const transientLayers = new TransientLayerRegistry(workspaceInteractionGate);
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
		projectResolution: { retain: vi.fn() } as never,
		appShell: appShell as never,
		workspaceInteractionGate,
		transientLayers,
		files: files as never,
		singletons: singletons as never,
		gitMutations: {
			pendingCount: (surfaceId: string) =>
				options.pendingGitSurfaceIds?.includes(surfaceId) ? 1 : 0,
		} as never,
		surfaceFrames: options.surfaceFrames,
		resolveSplitAdmission: options.resolveSplitAdmission ?? resolveUnmeasuredWorkspaceSplit,
		resolvePartitionRatioBounds: options.resolvePartitionRatioBounds ?? (() => null),
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
		workspaceInteractionGate,
		transientLayers,
	};
}

describe('WorkspaceCoordinator', () => {
	it('places a file as a tab in the target window', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.placeFileSession('window-file', { type: 'window', windowId: 'window-main' });

		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(
			fileSurfaceId('window-file'),
		);
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(fileSurfaceId('window-file'));
	});

	it('rolls back the publication when file placement fails to publish', async () => {
		const { coordinator, layout } = createHarness({
			failLayoutPublishAt: 1,
		});
		const publication = { publish: vi.fn(), rollback: vi.fn() };

		await expect(
			coordinator.placeFileSession(
				'failed-file',
				{ type: 'window', windowId: 'window-main' },
				publication,
			),
		).rejects.toThrow('layout publication failed');

		expect(publication.publish).toHaveBeenCalledOnce();
		expect(publication.rollback).toHaveBeenCalledOnce();
		expect(layout.surface(fileSurfaceId('failed-file'))).toBeNull();
	});

	it('places a file into a new window beside the anchor', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.placeFileSession('new-window-file', {
			type: 'new-window',
			anchorWindowId: 'window-main',
		});

		expect(windowCountOf(layout.snapshot)).toBe(3);
		const windowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			fileSurfaceId('new-window-file'),
		);
		expect(windowId).not.toBe('window-main');
		expect(windowTabs(layout.snapshot, windowId!).activeId).toBe(fileSurfaceId('new-window-file'));
	});

	it('falls back to a live window when a file destination closes before placement', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;

		const closing = coordinator.closeSurface('singleton:git-history');
		const placing = coordinator.placeFileSession('stale-window', {
			type: 'window',
			windowId: historyWindowId,
		});
		await Promise.all([closing, placing]);

		expect(windowIdOfSurface(layout.snapshot.desktopRoot, fileSurfaceId('stale-window'))).toBe(
			'window-main',
		);
	});

	it('restores the exact topology after exiting fullscreen', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const before = layout.snapshot;

		await coordinator.enterWindowFullscreen('window-main');
		expect(layout.snapshot.fullscreenWindowId).toBe('window-main');
		expect(layout.snapshot.desktopRoot).toBe(before.desktopRoot);
		expect(layout.snapshot.surfaces).toBe(before.surfaces);
		await coordinator.exitWindowFullscreen('window-main');
		expect(layout.snapshot.fullscreenWindowId).toBeNull();
		expect(layout.snapshot.desktopRoot).toBe(before.desktopRoot);
		expect(layout.snapshot.surfaces).toBe(before.surfaces);
	});

	it('blocks new windows until fullscreen exits', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.enterWindowFullscreen('window-main');

		expect(layout.snapshot.fullscreenWindowId).toBe('window-main');
		await expect(coordinator.openSingletonInNewWindow('git-history')).rejects.toMatchObject({
			message: 'Exit fullscreen to open a new window.',
		});
		expect(layout.snapshot.fullscreenWindowId).toBe('window-main');
		expect(windowCountOf(layout.snapshot)).toBe(2);
	});

	it('keeps hidden window surfaces and controllers alive while fullscreen', async () => {
		const { coordinator, layout, singletons } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		expect(windowCountOf(layout.snapshot)).toBe(3);

		await coordinator.enterWindowFullscreen('window-main');

		expect(layout.snapshot.fullscreenWindowId).toBe('window-main');
		expect(windowCountOf(layout.snapshot)).toBe(3);
		expect(layout.surface('singleton:git-history')).not.toBeNull();
		expect(singletons.disposeSurface).not.toHaveBeenCalled();
	});

	it('closes a Chat tab only when another Chat view remains', async () => {
		const { coordinator, layout } = createHarness();
		const mainChatSurfaceId = chatViewSurfaceId('window-main');

		expect(coordinator.isSurfaceCloseBlocked(mainChatSurfaceId)).toBe(true);
		await expect(coordinator.closeSurface(mainChatSurfaceId)).resolves.toBe(false);

		await coordinator.openChatInNewWindow('chat-b', 'window-main', 'right');
		expect(coordinator.isSurfaceCloseBlocked(mainChatSurfaceId)).toBe(false);
		await expect(coordinator.closeSurface(mainChatSurfaceId)).resolves.toBe(true);

		expect(layout.surface(mainChatSurfaceId)).toBeNull();
		expect(windowCountOf(layout.snapshot)).toBe(3);
		expect(
			Object.values(layout.snapshot.surfaces).filter((surface) => surface.type === 'chat'),
		).toHaveLength(1);
	});

	it('adds Chat to an exact window and publishes that destination as current', async () => {
		let coordinator: WorkspaceCoordinator | null = null;
		let observePlacement = false;
		let observed:
			| {
					currentWindowId: WorkspaceWindowId;
					lastFocusedSurfaceId: string;
			  }
			| undefined;
		const harness = createHarness({
			includePortableTabs: false,
			onLayoutChanged: () => {
				if (!observePlacement || !coordinator) return;
				observed = {
					currentWindowId: coordinator.currentWindowId,
					lastFocusedSurfaceId: coordinator.lastFocusedSurfaceId,
				};
			},
		});
		coordinator = harness.coordinator;
		const { layout } = harness;
		await coordinator.showChatInCurrentWindow('chat-a');
		await coordinator.openSingletonInNewWindow('git-history');
		const destinationWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		const destinationSurfaceId = chatViewSurfaceId(destinationWindowId);
		observePlacement = true;

		await coordinator.showChatInWindow('chat-b', destinationWindowId);

		expect(layout.surface(chatViewSurfaceId('window-main'))).toMatchObject({ chatId: 'chat-a' });
		expect(layout.surface(destinationSurfaceId)).toMatchObject({ chatId: 'chat-b' });
		expect(windowTabs(layout.snapshot, destinationWindowId).activeId).toBe(destinationSurfaceId);
		expect(observed).toEqual({
			currentWindowId: destinationWindowId,
			lastFocusedSurfaceId: destinationSurfaceId,
		});
	});

	it('keeps a current-window Chat intent anchored when focus changes before its commit', async () => {
		const { coordinator, layout } = createHarness({ includePortableTabs: false });
		await coordinator.openSingletonInNewWindow('git-history');
		const otherWindowId = windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		coordinator.noteWindowChromeFocus('window-main', chatViewSurfaceId('window-main'));

		const placement = coordinator.showChatInCurrentWindow('chat-a');
		coordinator.noteWindowChromeFocus(otherWindowId, 'singleton:git-history');
		await placement;

		expect(layout.surface(chatViewSurfaceId('window-main'))).toMatchObject({ chatId: 'chat-a' });
		expect(layout.surface(chatViewSurfaceId(otherWindowId))).toBeNull();
	});

	it('replaces Chat in an exact occupied window without changing another presentation', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.showChatInCurrentWindow('chat-a');
		const destinationWindowId = await coordinator.openChatInNewWindow(
			'chat-b',
			'window-main',
			'right',
		);

		await coordinator.showChatInWindow('chat-c', destinationWindowId);

		expect(layout.surface(chatViewSurfaceId('window-main'))).toMatchObject({ chatId: 'chat-a' });
		expect(layout.surface(chatViewSurfaceId(destinationWindowId))).toMatchObject({
			chatId: 'chat-c',
		});
		expect(
			Object.values(layout.snapshot.surfaces).filter((surface) => surface.type === 'chat'),
		).toHaveLength(2);
		expect(coordinator.currentWindowId).toBe(destinationWindowId);
	});

	it('does not redirect an exact Chat placement when its destination is missing', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.showChatInCurrentWindow('chat-a');

		await expect(
			coordinator.showChatInWindow('chat-b', 'window-missing' as WorkspaceWindowId),
		).rejects.toThrow();

		expect(layout.surface(chatViewSurfaceId('window-main'))).toMatchObject({ chatId: 'chat-a' });
		expect(windowCountOf(layout.snapshot)).toBe(2);
	});

	it('moves Chat into a Chat-less window and presents its destination identity', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.showChatInCurrentWindow('chat-a');
		await coordinator.openSingletonInNewWindow('git-history');
		const destinationWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		const sourceSurfaceId = chatViewSurfaceId('window-main');
		const destinationSurfaceId = chatViewSurfaceId(destinationWindowId);

		await coordinator.moveTabToWindow(sourceSurfaceId, destinationWindowId, 1);

		expect(layout.surface(sourceSurfaceId)).toBeNull();
		expect(layout.surface(destinationSurfaceId)).toMatchObject({ chatId: 'chat-a' });
		expect(windowTabs(layout.snapshot, destinationWindowId).order).toEqual([
			'singleton:git-history',
			destinationSurfaceId,
		]);
		expect(windowTabs(layout.snapshot, destinationWindowId).activeId).toBe(destinationSurfaceId);
		expect(coordinator.lastFocusedSurfaceId).toBe(destinationSurfaceId);
	});

	it('publishes Chat surface transfers for existing and new destination windows', async () => {
		const { coordinator, layout } = createHarness();
		const publications = [
			{ publish: vi.fn(), rollback: vi.fn() },
			{ publish: vi.fn(), rollback: vi.fn() },
		];
		const prepareChatSurfaceTransfer = vi
			.fn()
			.mockReturnValueOnce(publications[0])
			.mockReturnValueOnce(publications[1]);
		coordinator.registerChatSurfaceTransferPort({ prepareChatSurfaceTransfer });
		await coordinator.showChatInCurrentWindow('chat-a');
		await coordinator.openSingletonInNewWindow('git-history');
		const destinationWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		const sourceSurfaceId = chatViewSurfaceId('window-main');
		const destinationSurfaceId = chatViewSurfaceId(destinationWindowId);

		await coordinator.moveTabToWindow(sourceSurfaceId, destinationWindowId);
		await coordinator.moveTabToNewWindow(destinationSurfaceId, destinationWindowId, 'right');

		expect(prepareChatSurfaceTransfer).toHaveBeenCalledTimes(2);
		expect(prepareChatSurfaceTransfer).toHaveBeenNthCalledWith(1, {
			sourceSurfaceId,
			destinationSurfaceId,
			chatId: 'chat-a',
		});
		expect(prepareChatSurfaceTransfer.mock.calls[1]?.[0]).toMatchObject({
			sourceSurfaceId: destinationSurfaceId,
			chatId: 'chat-a',
		});
		expect(prepareChatSurfaceTransfer.mock.calls[1]?.[0].destinationSurfaceId).not.toBe(
			destinationSurfaceId,
		);
		expect(publications[0].publish).toHaveBeenCalledOnce();
		expect(publications[1].publish).toHaveBeenCalledOnce();
		expect(publications[0].rollback).not.toHaveBeenCalled();
		expect(publications[1].rollback).not.toHaveBeenCalled();
	});

	it('rolls back a Chat surface transfer when layout publication fails', async () => {
		const { coordinator, layout } = createHarness({ failLayoutPublishAt: 3 });
		const publication = { publish: vi.fn(), rollback: vi.fn() };
		const prepareChatSurfaceTransfer = vi.fn(() => publication);
		coordinator.registerChatSurfaceTransferPort({ prepareChatSurfaceTransfer });
		await coordinator.showChatInCurrentWindow('chat-a');
		await coordinator.openSingletonInNewWindow('git-history');
		const destinationWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;

		await expect(
			coordinator.moveTabToWindow(chatViewSurfaceId('window-main'), destinationWindowId),
		).rejects.toThrow('layout publication failed');

		expect(prepareChatSurfaceTransfer).toHaveBeenCalledOnce();
		expect(publication.publish).toHaveBeenCalledOnce();
		expect(publication.rollback).toHaveBeenCalledOnce();
		expect(layout.surface(chatViewSurfaceId('window-main'))).toMatchObject({ chatId: 'chat-a' });
		expect(layout.surface(chatViewSurfaceId(destinationWindowId))).toBeNull();
	});

	it('publishes a collapsing Chat move with the destination already current', async () => {
		let coordinator: WorkspaceCoordinator | null = null;
		let observeMove = false;
		let observed:
			| {
					currentWindowId: WorkspaceWindowId;
					focusOwner: WorkspaceCoordinator['focusOwner'];
					lastFocusedSurfaceId: string;
			  }
			| undefined;
		const harness = createHarness({
			includePortableTabs: false,
			onLayoutChanged: () => {
				if (!observeMove || !coordinator) return;
				observed = {
					currentWindowId: coordinator.currentWindowId,
					focusOwner: coordinator.focusOwner,
					lastFocusedSurfaceId: coordinator.lastFocusedSurfaceId,
				};
			},
		});
		coordinator = harness.coordinator;
		const { layout } = harness;
		await coordinator.showChatInCurrentWindow('chat-a');
		await coordinator.openSingletonInNewWindow('git-history');
		const destinationWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		const sourceSurfaceId = chatViewSurfaceId('window-main');
		const destinationSurfaceId = chatViewSurfaceId(destinationWindowId);
		await coordinator.focusSurface(sourceSurfaceId);
		observeMove = true;

		await coordinator.moveTabToWindow(sourceSurfaceId, destinationWindowId);

		expect(observed).toEqual({
			currentWindowId: destinationWindowId,
			focusOwner: { kind: 'surface', surfaceId: destinationSurfaceId },
			lastFocusedSurfaceId: destinationSurfaceId,
		});
		expect(windowCountOf(layout.snapshot)).toBe(2);
	});

	it('replaces and focuses an existing destination Chat presentation', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.showChatInCurrentWindow('chat-a');
		const destinationWindowId = await coordinator.openChatInNewWindow(
			'chat-b',
			'window-main',
			'right',
		);
		const sourceSurfaceId = chatViewSurfaceId('window-main');
		const destinationSurfaceId = chatViewSurfaceId(destinationWindowId);

		await coordinator.moveTabToWindow(sourceSurfaceId, destinationWindowId);

		expect(layout.surface(sourceSurfaceId)).toBeNull();
		expect(layout.surface(destinationSurfaceId)).toMatchObject({ chatId: 'chat-a' });
		expect(windowTabs(layout.snapshot, destinationWindowId).activeId).toBe(destinationSurfaceId);
		expect(coordinator.lastFocusedSurfaceId).toBe(destinationSurfaceId);
		expect(windowCountOf(layout.snapshot)).toBe(3);
	});

	it('moves Chat directionally instead of copying its source presentation', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.showChatInCurrentWindow('chat-a');
		const sourceSurfaceId = chatViewSurfaceId('window-main');

		await coordinator.moveTabToNewWindow(sourceSurfaceId, 'window-main', 'right');

		const movedChat = Object.values(layout.snapshot.surfaces).find(
			(surface) => surface.type === 'chat' && surface.chatId === 'chat-a',
		);
		expect(movedChat?.id).not.toBe(sourceSurfaceId);
		expect(layout.surface(sourceSurfaceId)).toBeNull();
		expect(windowCountOf(layout.snapshot)).toBe(3);
		expect(coordinator.lastFocusedSurfaceId).toBe(movedChat?.id);
	});

	it('keeps the explicit sidebar-style Chat new-window intent as a copy', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.showChatInCurrentWindow('chat-a');

		const destinationWindowId = await coordinator.openChatInNewWindow(
			'chat-a',
			'window-main',
			'right',
		);

		expect(layout.surface(chatViewSurfaceId('window-main'))).toMatchObject({ chatId: 'chat-a' });
		expect(layout.surface(chatViewSurfaceId(destinationWindowId))).toMatchObject({
			chatId: 'chat-a',
		});
	});

	it('keeps a sole-tab directional Chat move as a no-op', async () => {
		const { coordinator, layout } = createHarness({ includePortableTabs: false });
		await coordinator.showChatInCurrentWindow('chat-a');
		const before = layout.snapshot;

		await coordinator.moveTabToNewWindow(chatViewSurfaceId('window-main'), 'window-main', 'right');

		expect(layout.snapshot).toBe(before);
		expect(windowCountOf(layout.snapshot)).toBe(2);
	});

	it('blocks closing the window that owns the final Chat view', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');

		expect(coordinator.isWindowCloseBlocked('window-main')).toBe(true);
		await expect(coordinator.closeWindow('window-main')).resolves.toBe(false);
		expect(layout.surface(chatViewSurfaceId('window-main'))).not.toBeNull();
		expect(windowCountOf(layout.snapshot)).toBe(3);
	});

	it('reconciles a hidden terminal that exits while another window is fullscreen', async () => {
		const { coordinator, layout, terminals } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		const terminalId = 'terminal-fullscreen-race';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, historyWindowId);
		await coordinator.enterWindowFullscreen('window-main');
		await coordinator.handleTerminalSessionTerminated(terminalId);

		expect(layout.surface(terminalSurfaceId(terminalId))).toBeNull();
		expect(layout.snapshot.unplacedTerminalIds).not.toContain(terminalId);
		expect(windowCountOf(layout.snapshot)).toBe(3);
	});

	it('falls back from a closed last-focused window', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		expect(coordinator.lastFocusedWindowId).toBe(historyWindowId);

		await coordinator.closeSurface('singleton:git-history');

		expect(coordinator.lastFocusedWindowId).toBe('window-main');
	});

	it('preserves current-window and composer ownership when an inactive window tab closes', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		await coordinator.openSingletonAsTab('files', historyWindowId);
		await coordinator.focusChat();
		const ownerBefore = coordinator.focusOwner;
		const composerAnchorBefore = coordinator.composerAnchorSurfaceId;

		await expect(coordinator.closeSurface('singleton:files')).resolves.toBe(true);

		expect(coordinator.currentWindowId).toBe('window-main');
		expect(coordinator.lastFocusedSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
		expect(coordinator.focusOwner).toEqual(ownerBefore);
		expect(coordinator.composerAnchorSurfaceId).toBe(composerAnchorBefore);
		expect(windowTabs(layout.snapshot, historyWindowId).activeId).toBe('singleton:git-history');
	});

	it('cancels workspace drag before fullscreen and preserves topology on publication failure', async () => {
		const successful = createHarness();
		const cancel = vi.spyOn(successful.workspaceInteractionGate, 'cancelBeforeInertTransition');
		await successful.coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			successful.layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		await successful.coordinator.enterWindowFullscreen(historyWindowId);
		expect(cancel).toHaveBeenCalled();
		expect(successful.coordinator.isChatPresented).toBe(false);

		const failed = createHarness({ failLayoutPublishAt: 1 });
		await expect(failed.coordinator.enterWindowFullscreen('window-main')).rejects.toThrow(
			'layout publication failed',
		);
		expect(failed.layout.snapshot.fullscreenWindowId).toBeNull();
		expect(failed.coordinator.isChatPresented).toBe(true);
	});

	it('lets the first of two concurrent close requests own the topology', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;

		const [first, second] = await Promise.all([
			coordinator.closeWindow(historyWindowId),
			coordinator.closeWindow('window-main'),
		]);

		expect([first, second].filter(Boolean)).toHaveLength(1);
		expect(windowCountOf(layout.snapshot)).toBe(2);
	});

	it('places files in the mobile-only presentation regardless of a desktop target', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.enterMobilePresentation();

		await coordinator.placeFileSession('mobile-file', { type: 'window', windowId: 'window-main' });

		const surfaceId = fileSurfaceId('mobile-file');
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(surfaceId);
		expect(layout.snapshot.mobileOnlySurfaceIds).toContain(surfaceId);
		expect(layout.snapshot.dialogFileSurfaceId).toBeNull();
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, surfaceId)).toBeNull();
	});

	it('destroys a mobile file session and returns to Chat when it is closed', async () => {
		const confirmDestructive = vi.fn(async () => true);
		const { coordinator, files, layout, appShell } = createHarness({ confirmDestructive });
		await coordinator.enterMobilePresentation();
		await coordinator.placeFileSession('mobile-file');
		const surfaceId = fileSurfaceId('mobile-file');
		appShell.requestComposerFocus.mockClear();

		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

		expect(confirmDestructive).toHaveBeenCalledWith('mobile-file', 'close');
		expect(files.destroy).toHaveBeenCalledWith('mobile-file');
		expect(layout.surface(surfaceId)).toBeNull();
		expect(layout.snapshot.mobileOnlySurfaceIds).not.toContain(surfaceId);
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
		expect(coordinator.lastFocusedSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
		expect(appShell.requestComposerFocus).toHaveBeenCalledOnce();
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

	it('restores the dialog return surface when an inactive popped-out file closes', async () => {
		const { coordinator, appShell, layout } = createHarness();
		await coordinator.placeFileSession('inactive-dialog', {
			type: 'window',
			windowId: 'window-main',
		});
		const surfaceId = fileSurfaceId('inactive-dialog');
		await coordinator.focusChat();
		await expect(coordinator.popOutFile(surfaceId)).resolves.toBe(true);
		expect(coordinator.focusOwner).toEqual({
			kind: 'surface',
			surfaceId: CANONICAL_CHAT_SURFACE_ID,
		});
		expect(coordinator.lastFocusedSurfaceId).toBe(surfaceId);
		appShell.requestComposerFocus.mockClear();

		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

		expect(layout.snapshot.dialogFileSurfaceId).toBeNull();
		expect(layout.surface(surfaceId)).toBeNull();
		expect(coordinator.lastFocusedSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
		expect(coordinator.focusOwner).toEqual({
			kind: 'surface',
			surfaceId: CANONICAL_CHAT_SURFACE_ID,
		});
		expect(appShell.requestComposerFocus).toHaveBeenCalledOnce();
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

	it('rejects moving a dialog file into a window that closed before publication', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.placeFileSession('dialog-stale-window', { type: 'dialog' });
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;

		const closing = coordinator.closeSurface('singleton:git-history');
		const moving = coordinator.moveDialogFileToWindow(historyWindowId);
		await closing;

		await expect(moving).rejects.toThrow('destination window is no longer available');
		expect(layout.snapshot.dialogFileSurfaceId).toBe(fileSurfaceId('dialog-stale-window'));
	});

	it('closes a running terminal tab without terminating its session and can reopen it', async () => {
		const { coordinator, layout, terminals } = createHarness();
		const terminalId = 'terminal-unplaced';
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'window-main');
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

		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		await coordinator.openTerminalSession(terminalId, historyWindowId);
		expect(windowTabs(layout.snapshot, historyWindowId).order).toContain(surfaceId);
		expect(layout.snapshot.unplacedTerminalIds).not.toContain(terminalId);
	});

	it('deletes an exited terminal when its tab closes', async () => {
		const { coordinator, layout, terminals } = createHarness();
		const terminalId = 'terminal-exited';
		terminals.sessions[terminalId] = {
			metadata: { ...terminalMetadata(terminalId), processStatus: 'exited', exitCode: 0 },
			attachmentState: 'detached',
		};
		await coordinator.openTerminalSession(terminalId, 'window-main');
		const surfaceId = terminalSurfaceId(terminalId);

		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

		expect(terminals.requestTermination).toHaveBeenCalledWith(terminalId, expect.any(String));
		expect(terminals.disposeTerminatedSession).toHaveBeenCalledWith(terminalId);
		expect(layout.surface(surfaceId)).toBeNull();
		expect(layout.snapshot.unplacedTerminalIds).not.toContain(terminalId);
	});

	it('keeps an exited terminal unplaced and reuses its cleanup request after a network failure', async () => {
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
		const { coordinator, layout, terminals } = createHarness({ terminate });
		const terminalId = 'terminal-cleanup-retry';
		terminals.sessions[terminalId] = {
			metadata: { ...terminalMetadata(terminalId), processStatus: 'exited', exitCode: 1 },
			attachmentState: 'detached',
		};
		await coordinator.openTerminalSession(terminalId, 'window-main');
		const surfaceId = terminalSurfaceId(terminalId);

		await expect(coordinator.closeSurface(surfaceId)).rejects.toThrow('network lost');

		expect(layout.surface(surfaceId)).toBeNull();
		expect(layout.snapshot.unplacedTerminalIds).toContain(terminalId);
		expect(terminals.disposeTerminatedSession).not.toHaveBeenCalled();

		await coordinator.openTerminalSession(terminalId, 'window-main');
		await expect(coordinator.closeSurface(surfaceId)).resolves.toBe(true);

		expect(requestIds[1]).toBe(requestIds[0]);
		expect(layout.snapshot.unplacedTerminalIds).not.toContain(terminalId);
	});

	it('does not delete an exited terminal when its tab fails to close', async () => {
		const { coordinator, layout, terminals } = createHarness({ failLayoutPublishAt: 2 });
		const terminalId = 'terminal-close-failed';
		terminals.sessions[terminalId] = {
			metadata: { ...terminalMetadata(terminalId), processStatus: 'exited', exitCode: 1 },
			attachmentState: 'detached',
		};
		await coordinator.openTerminalSession(terminalId, 'window-main');
		const surfaceId = terminalSurfaceId(terminalId);

		await expect(coordinator.closeSurface(surfaceId)).rejects.toThrow('layout publication failed');

		expect(layout.surface(surfaceId)).not.toBeNull();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
		expect(terminals.disposeTerminatedSession).not.toHaveBeenCalled();
	});

	it('joins remote deletion while cleaning up an exited terminal tab', async () => {
		const deletion = deferred<void>();
		const terminate = vi.fn(() => deletion.promise);
		const { coordinator, layout, terminals } = createHarness({ terminate });
		const terminalId = 'terminal-cleanup-remote-race';
		terminals.sessions[terminalId] = {
			metadata: { ...terminalMetadata(terminalId), processStatus: 'exited', exitCode: 0 },
			attachmentState: 'detached',
		};
		await coordinator.openTerminalSession(terminalId, 'window-main');
		const surfaceId = terminalSurfaceId(terminalId);

		const closing = coordinator.closeSurface(surfaceId);
		await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
		await coordinator.handleTerminalSessionTerminated(terminalId);
		deletion.resolve();
		await expect(closing).resolves.toBe(true);

		expect(terminate).toHaveBeenCalledOnce();
		expect(layout.surface(surfaceId)).toBeNull();
		expect(layout.snapshot.unplacedTerminalIds).not.toContain(terminalId);
	});

	it('deletes only exited terminals when their whole window closes', async () => {
		const { coordinator, layout, terminals } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const windowId = windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-history')!;
		const runningTerminalId = 'terminal-window-running';
		const exitedTerminalId = 'terminal-window-exited';
		terminals.sessions[runningTerminalId] = {
			metadata: terminalMetadata(runningTerminalId),
			attachmentState: 'attached',
		};
		terminals.sessions[exitedTerminalId] = {
			metadata: {
				...terminalMetadata(exitedTerminalId),
				processStatus: 'exited',
				exitCode: 2,
			},
			attachmentState: 'detached',
		};
		await coordinator.openTerminalSession(runningTerminalId, windowId);
		await coordinator.openTerminalSession(exitedTerminalId, windowId);

		await expect(coordinator.closeWindow(windowId)).resolves.toBe(true);

		expect(terminals.requestTermination).toHaveBeenCalledOnce();
		expect(terminals.requestTermination).toHaveBeenCalledWith(exitedTerminalId, expect.any(String));
		expect(terminals.disposeTerminatedSession).toHaveBeenCalledWith(exitedTerminalId);
		expect(terminals.disposeTerminatedSession).not.toHaveBeenCalledWith(runningTerminalId);
		expect(layout.snapshot.unplacedTerminalIds).toContain(runningTerminalId);
		expect(layout.snapshot.unplacedTerminalIds).not.toContain(exitedTerminalId);
	});

	it('rejects tab moves while explicit terminal termination owns the destructive reservation', async () => {
		const termination = deferred<void>();
		const terminate = vi.fn(() => termination.promise);
		const { coordinator, layout, terminals } = createHarness({ terminate });
		const terminalId = 'terminal-1';
		terminals.sessions[terminalId] = {
			metadata: { ...terminalMetadata(terminalId), title: 'Build logs' },
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'window-main');
		const surfaceId = terminalSurfaceId(terminalId);

		const terminationRequest = coordinator.terminateTerminalSession(terminalId);
		expect(coordinator.closeGuardRequest?.surfaceId).toBe(surfaceId);
		expect(coordinator.closeGuardRequest?.title).toBe('Terminate Build logs?');
		coordinator.resolveCloseGuard(true);
		await Promise.resolve();
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		await coordinator.moveTabToWindow(surfaceId, historyWindowId);
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(surfaceId);
		expect(windowTabs(layout.snapshot, historyWindowId).order).not.toContain(surfaceId);

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
		await coordinator.openTerminalSession(terminalId, 'window-main');
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
		await coordinator.openTerminalSession(terminalId, 'window-main');
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
		await coordinator.placeFileSession('saving', { type: 'window', windowId: 'window-main' });
		await coordinator.openSingletonAsTab('commit', 'window-main');

		expect(coordinator.isSurfaceCloseBlocked(fileSurfaceId('saving'))).toBe(true);
		expect(coordinator.isSurfaceCloseBlocked('singleton:commit')).toBe(true);
		await expect(coordinator.closeSurface(fileSurfaceId('saving'))).resolves.toBe(false);
		await expect(coordinator.closeSurface('singleton:commit')).resolves.toBe(false);
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(fileSurfaceId('saving'));
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain('singleton:commit');
	});

	it('blocks the invoking Git singleton while its branch mutation is pending', async () => {
		const { coordinator } = createHarness({ pendingGitSurfaceIds: ['singleton:git'] });

		expect(coordinator.isSurfaceCloseBlocked('singleton:git')).toBe(true);
		await expect(coordinator.closeSurface('singleton:git')).resolves.toBe(false);
	});

	it('enters fullscreen without destructive confirmation for hidden dirty surfaces', async () => {
		const confirmDestructive = vi.fn(async () => true);
		const { coordinator, layout } = createHarness({ confirmDestructive });
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		await coordinator.placeFileSession('fullscreen-reserved', {
			type: 'window',
			windowId: historyWindowId,
		});

		await expect(coordinator.enterWindowFullscreen('window-main')).resolves.toBe(true);

		expect(confirmDestructive).not.toHaveBeenCalled();
		expect(layout.snapshot.fullscreenWindowId).toBe('window-main');
		expect(windowCountOf(layout.snapshot)).toBe(3);
		expect(layout.surface(fileSurfaceId('fullscreen-reserved'))).not.toBeNull();
	});

	it('publishes placement before awaiting the exact destination frame', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const opening = coordinator.openSingletonAsTab('files', 'window-main');
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:files'),
		);
		expect(coordinator.frameVersion('singleton:files')).toBe(1);

		const attachRetainedRenderer = vi.fn();
		frames.register('singleton:files', 'window-main', {
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
		const opening = coordinator.openSingletonAsTab('files', 'window-main');
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:files'),
		);
		const failedBridge = new SurfaceFrameBridge();
		const failedActivation = vi.fn(() => failedBridge.activate());
		frames.register('singleton:files', 'window-main', {
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
		const retry = coordinator.retryPresentation('singleton:files', 'window-main');
		expect(coordinator.attachmentErrors['singleton:files']).toBeUndefined();
		await vi.waitFor(() => expect(coordinator.frameVersion('singleton:files')).toBe(2));
		const retryBridge = new SurfaceFrameBridge();
		const attachRetainedRenderer = vi.fn(() => retryBridge.activate());
		frames.register('singleton:files', 'window-main', {
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
		const retry = coordinator.retryPresentation('singleton:git', 'window-main');
		await vi.waitFor(() => expect(coordinator.frameVersion('singleton:git')).toBe(1));
		frames.register('singleton:git', 'window-main', {
			element: document.createElement('div'),
			attachRetainedRenderer: attachGit,
			focusPrimary: focusGit,
		});
		await vi.waitFor(() => expect(attachGit).toHaveBeenCalledOnce());

		const focusPullRequests = vi.fn();
		const focusNext = coordinator.focusSurface('singleton:pull-requests');
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:pull-requests'),
		);
		frames.register('singleton:pull-requests', 'window-main', {
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

	it('publishes responsive mode with the layout and replaces a hidden focus owner', async () => {
		const { coordinator, appShell, layout } = createHarness();
		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:git' };
		coordinator.lastFocusedSurfaceId = CANONICAL_CHAT_SURFACE_ID;

		await coordinator.enterMobilePresentation();

		expect(coordinator.isMobile).toBe(true);
		expect(appShell.isMobile).toBe(true);
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
		expect(coordinator.focusOwner).toEqual({
			kind: 'surface',
			surfaceId: CANONICAL_CHAT_SURFACE_ID,
		});
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
			expect(layout.snapshot.mobileActiveSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
			expect(singletons.disposeSurface).toHaveBeenCalledWith(kind);
		},
	);

	it('returns from a removed mobile-active window tab to an inactive Chat tab', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.focusSurface('singleton:git');
		await coordinator.enterMobilePresentation();

		expect(layout.snapshot.mobileActiveSurfaceId).toBe('singleton:git');
		await expect(coordinator.closeSurface('singleton:git')).resolves.toBe(true);

		expect(layout.surface('singleton:git')).toBeNull();
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
	});

	it('returns from a removed mobile-active tab to the prior tab in its source window', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.moveTabToWindow('singleton:git', 'window-files');
		await coordinator.focusSurface('singleton:git');
		await coordinator.enterMobilePresentation();

		expect(layout.snapshot.mobileActiveSurfaceId).toBe('singleton:git');
		await expect(coordinator.closeSurface('singleton:git')).resolves.toBe(true);

		expect(layout.surface('singleton:git')).toBeNull();
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(CANONICAL_FILES_SURFACE_ID);
	});

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
		await coordinator.openSingletonAsTab('git-history', 'window-main');
		await coordinator.enterMobilePresentation();
		await coordinator.focusMobileSingleton('git-history');

		await coordinator.exitMobilePresentation();

		expect(windowTabs(layout.snapshot, 'window-main').order).toContain('singleton:git-history');
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

	it('routes chat navigation shortcuts within a main-inert chat list', () => {
		const { coordinator, transientLayers, appShell, files } = createHarness();
		const requestNavigateChatBelow = vi.fn();
		const dispatcher = new WorkspaceShortcutDispatcher({
			workspace: coordinator,
			transients: transientLayers,
			appShell: appShell as never,
			navigation: {
				requestNavigateChatAbove: vi.fn(),
				requestNavigateChatBelow,
			} as never,
			files: files as never,
			localSettings: { globalShortcuts: {} },
		});
		const chatList = document.createElement('div');
		chatList.dataset.workspaceChatList = '';
		const target = document.createElement('button');
		chatList.append(target);
		document.body.append(chatList);
		const unregister = transientLayers.register({
			id: 'mobile-chat-list',
			kind: 'sidebar-overlay',
			modality: 'main-inert',
			isOpen: () => true,
			element: () => chatList,
			onEscape: () => true,
			restoreFocus: () => undefined,
		});
		target.addEventListener('keydown', (event) => dispatcher.handle(event));
		const event = new KeyboardEvent('keydown', {
			key: 'n',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		target.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(requestNavigateChatBelow).toHaveBeenCalledOnce();
		unregister();
		chatList.remove();
	});

	it('does not restore focus or recency after a presentation is superseded', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const focusGit = coordinator.focusSurface('singleton:git');
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:git'),
		);

		const focusPullRequests = coordinator.focusSurface('singleton:pull-requests');
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:pull-requests'),
		);
		const focusPrimary = vi.fn();
		frames.register('singleton:pull-requests', 'window-main', {
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
			type: 'window',
			windowId: 'window-main',
		});
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(surfaceId),
		);

		const focusGit = coordinator.focusSurface('singleton:git');
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:git'),
		);
		frames.register('singleton:git', 'window-main', {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary: vi.fn(),
		});

		await expect(placement).resolves.toBe('placed');
		await focusGit;
		expect(layout.surface(surfaceId)).not.toBeNull();
	});

	it('keeps a later Chat focus when an older file presentation settles', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout, appShell } = createHarness({ surfaceFrames: frames });
		const filesWindowId = 'window-files' as WorkspaceWindowId;
		coordinator.noteSurfaceFocus('singleton:files');
		const surfaceId = fileSurfaceId('delayed-file');
		const placement = coordinator.placeFileSession('delayed-file', {
			type: 'window',
			windowId: filesWindowId,
		});
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, filesWindowId).activeId).toBe(surfaceId),
		);

		await coordinator.focusSurface(CANONICAL_CHAT_SURFACE_ID);
		const staleFileFocus = vi.fn();
		frames.register(surfaceId, filesWindowId, {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary: staleFileFocus,
		});

		await expect(placement).resolves.toBe('placed');
		expect(coordinator.lastFocusedSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
		expect(appShell.requestComposerFocus).toHaveBeenCalledOnce();
		expect(staleFileFocus).not.toHaveBeenCalled();
	});

	it('keeps later window chrome focus when an older file presentation settles', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, layout } = createHarness({ surfaceFrames: frames });
		const filesWindowId = 'window-files' as WorkspaceWindowId;
		const surfaceId = fileSurfaceId('delayed-file');
		const placement = coordinator.placeFileSession('delayed-file', {
			type: 'window',
			windowId: filesWindowId,
		});
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, filesWindowId).activeId).toBe(surfaceId),
		);

		coordinator.noteWindowChromeFocus('window-main', CANONICAL_CHAT_SURFACE_ID);
		const staleFileFocus = vi.fn();
		frames.register(surfaceId, filesWindowId, {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary: staleFileFocus,
		});

		await expect(placement).resolves.toBe('placed');
		expect(coordinator.focusOwner).toEqual({
			kind: 'window-chrome',
			windowId: 'window-main',
			surfaceId: CANONICAL_CHAT_SURFACE_ID,
		});
		expect(staleFileFocus).not.toHaveBeenCalled();
	});

	it('focuses an existing surface by activating its window-local tab', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonAsTab('files', 'window-main');
		await coordinator.focusChat();
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(CANONICAL_CHAT_SURFACE_ID);

		await coordinator.focusSurface('singleton:files');

		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:files');
	});

	it('requests composer focus when Chat becomes the focused surface', async () => {
		const { coordinator, appShell } = createHarness({ initialActiveSurfaceId: 'singleton:git' });

		await coordinator.focusChat();

		expect(appShell.requestComposerFocus).toHaveBeenCalledOnce();
	});

	it('activates an inactive window synchronously and focuses its active surface after rendering', async () => {
		const frames = new SurfaceFrameRegistry();
		const { coordinator, appShell } = createHarness({ surfaceFrames: frames });
		coordinator.noteWindowChromeFocus('window-files', 'singleton:files');

		coordinator.activateWindow('window-main');

		expect(coordinator.currentWindowId).toBe('window-main');
		expect(coordinator.lastFocusedSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
		expect(appShell.requestComposerFocus).not.toHaveBeenCalled();
		await tick();
		expect(appShell.requestComposerFocus).toHaveBeenCalledOnce();
	});

	it('promotes a presented pane when keyboard focus enters it', () => {
		const { coordinator } = createHarness();

		coordinator.noteSurfaceFocus('singleton:files');

		expect(coordinator.currentWindowId).toBe('window-files');
		expect(coordinator.lastFocusedSurfaceId).toBe('singleton:files');
		expect(coordinator.focusOwner).toEqual({
			kind: 'surface',
			surfaceId: 'singleton:files',
		});
		expect(coordinator.composerAnchorSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
	});

	it('updates command ownership on pointerdown and defers Chat anchoring until click', () => {
		const { coordinator, layout } = createHarness();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'open-chat-in-new-window',
					chatId: 'chat-b',
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-chat',
					partitionId: 'partition-chat',
				},
			]),
		);
		const surfaceId = chatViewSurfaceId('window-chat');

		coordinator.beginWindowPointerInteraction('window-chat', 7);
		coordinator.activateWindow('window-chat');
		coordinator.noteSurfaceFocus(surfaceId);

		expect(coordinator.currentWindowId).toBe('window-chat');
		expect(coordinator.focusOwner).toEqual({ kind: 'surface', surfaceId });
		expect(coordinator.composerAnchorSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);

		coordinator.commitWindowPointerInteraction('window-chat');

		expect(coordinator.composerAnchorSurfaceId).toBe(surfaceId);
	});

	it('retains a hidden Chat anchor until its surface is removed', async () => {
		const { coordinator, layout } = createHarness();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'open-chat-in-new-window',
					chatId: 'chat-b',
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-chat',
					partitionId: 'partition-chat',
				},
			]),
		);
		await coordinator.openSingletonAsTab('git', 'window-main');

		expect(coordinator.composerAnchorSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);

		await expect(coordinator.closeSurface(CANONICAL_CHAT_SURFACE_ID)).resolves.toBe(true);

		expect(coordinator.composerAnchorSurfaceId).toBeNull();
	});

	it('clears cancelled and released pointer gestures without changing the Chat anchor', async () => {
		const { coordinator, layout } = createHarness();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'open-chat-in-new-window',
					chatId: 'chat-b',
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-chat',
					partitionId: 'partition-chat',
				},
			]),
		);
		const surfaceId = chatViewSurfaceId('window-chat');

		coordinator.beginWindowPointerInteraction('window-chat', 7);
		coordinator.cancelWindowPointerInteraction('window-chat', 7);
		expect(coordinator.composerAnchorSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);

		coordinator.beginWindowPointerInteraction('window-chat', 8);
		coordinator.releaseWindowPointerInteraction('window-chat', 8);
		coordinator.noteSurfaceFocus(surfaceId);
		expect(coordinator.composerAnchorSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);

		await new Promise((resolve) => setTimeout(resolve, 0));
		coordinator.noteSurfaceFocus(surfaceId);
		expect(coordinator.composerAnchorSurfaceId).toBe(surfaceId);
	});

	it('moves between tabs in the focused window without wrapping at either boundary', async () => {
		const { coordinator, layout } = createHarness();
		coordinator.focusOwner = { kind: 'surface', surfaceId: CANONICAL_CHAT_SURFACE_ID };

		expect(coordinator.focusPreviousTabInFocusedWindow()).toBe(true);
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(CANONICAL_CHAT_SURFACE_ID);
		expect(coordinator.focusNextTabInFocusedWindow()).toBe(true);
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:git'),
		);

		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:git' };
		expect(coordinator.focusNextTabInFocusedWindow()).toBe(true);
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:pull-requests'),
		);
		coordinator.focusOwner = { kind: 'surface', surfaceId: 'singleton:pull-requests' };
		expect(coordinator.focusNextTabInFocusedWindow()).toBe(true);
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:pull-requests');
	});

	it('cycles focus across windows with the window focus shortcut', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const destinationWindowId = coordinator.windowOf('singleton:git-history');
		if (!destinationWindowId) throw new Error('Expected Git History window');
		const filesWindowId = coordinator.windowOf(CANONICAL_FILES_SURFACE_ID);
		if (!filesWindowId) throw new Error('Expected Files window');
		const activateWindow = vi.spyOn(coordinator, 'activateWindow');
		coordinator.focusOwner = { kind: 'surface', surfaceId: CANONICAL_CHAT_SURFACE_ID };
		const revision = layout.revision;

		coordinator.cycleWindowFocus();
		expect(activateWindow).toHaveBeenLastCalledWith(destinationWindowId);
		expect(layout.revision).toBe(revision);

		coordinator.cycleWindowFocus({ kind: 'surface', surfaceId: 'singleton:git-history' });
		expect(activateWindow).toHaveBeenLastCalledWith(filesWindowId);
		expect(layout.revision).toBe(revision);

		coordinator.cycleWindowFocus({ kind: 'surface', surfaceId: CANONICAL_FILES_SURFACE_ID });
		expect(activateWindow).toHaveBeenLastCalledWith('window-main');
		expect(layout.revision).toBe(revision);
		expect(layout.snapshot.fullscreenWindowId).toBeNull();
	});

	it('does not cycle focus into hidden windows during fullscreen', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		await coordinator.enterWindowFullscreen('window-main');
		const activateWindow = vi.spyOn(coordinator, 'activateWindow');

		coordinator.cycleWindowFocus({ kind: 'surface', surfaceId: CANONICAL_CHAT_SURFACE_ID });

		expect(activateWindow).not.toHaveBeenCalled();
		expect(layout.snapshot.fullscreenWindowId).toBe('window-main');
	});

	it('skips windows whose active surface is reserved while cycling', async () => {
		const confirmation = deferred<boolean>();
		const { coordinator } = createHarness({
			confirmDestructive: () => confirmation.promise,
			fileEditor: { prepareRendererTransfer: vi.fn() },
		});
		await coordinator.placeFileSession('reserved-file', {
			type: 'new-window',
			anchorWindowId: 'window-main',
		});
		const fileId = fileSurfaceId('reserved-file');
		const fileWindowId = coordinator.windowOf(fileId);
		if (!fileWindowId) throw new Error('Expected File window');
		await coordinator.openSingletonInNewWindow('git-history', fileWindowId);
		const availableWindowId = coordinator.windowOf('singleton:git-history');
		if (!availableWindowId) throw new Error('Expected Git History window');

		const close = coordinator.closeSurface(fileId);
		await vi.waitFor(() => expect(coordinator.isSurfaceCloseBlocked(fileId)).toBe(true));
		const activateWindow = vi.spyOn(coordinator, 'activateWindow');

		coordinator.cycleWindowFocus({ kind: 'surface', surfaceId: CANONICAL_CHAT_SURFACE_ID });

		expect(activateWindow).toHaveBeenCalledOnce();
		expect(activateWindow).toHaveBeenCalledWith(availableWindowId);
		confirmation.resolve(false);
		await expect(close).resolves.toBe(false);
	});

	it('does not navigate window tabs from the chat list or mobile presentation', async () => {
		const { coordinator, appShell, layout } = createHarness();
		coordinator.focusOwner = { kind: 'chat-list' };
		expect(coordinator.focusNextTabInFocusedWindow()).toBe(false);
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(CANONICAL_CHAT_SURFACE_ID);

		appShell.isMobile = true;
		await coordinator.enterMobilePresentation();
		coordinator.focusOwner = { kind: 'surface', surfaceId: CANONICAL_CHAT_SURFACE_ID };
		expect(coordinator.focusNextTabInFocusedWindow()).toBe(false);
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
	});

	it('rechecks and clamps partition ratios inside the serialized commit', async () => {
		let min = 0.4;
		let max = 0.6;
		let adjustable = true;
		const resolver = vi.fn<WorkspacePartitionRatioBoundsResolver>((snapshot, partitionId) => {
			const root = snapshot.desktopRoot;
			if (root.type !== 'partition' || root.id !== partitionId) return null;
			return { currentRatio: root.ratio, bounds: { min, max, adjustable } };
		});
		const { coordinator, layout } = createHarness({ resolvePartitionRatioBounds: resolver });
		await coordinator.openSingletonInNewWindow('git-history');
		const root = layout.snapshot.desktopRoot;
		if (root.type !== 'partition') throw new Error('Expected partition root');
		const initialRatio = root.ratio;

		await coordinator.setPartitionRatio(root.id, 0.9);
		expect(layout.snapshot.desktopRoot).toMatchObject({ ratio: 0.6 });
		expect(resolver).toHaveBeenLastCalledWith(
			expect.objectContaining({ desktopRoot: expect.objectContaining({ ratio: initialRatio }) }),
			root.id,
		);

		min = 0.6;
		max = 0.6;
		adjustable = false;
		const revision = layout.revision;
		await coordinator.setPartitionRatio(root.id, 0.2);

		expect(layout.revision).toBe(revision);
		expect(layout.snapshot.desktopRoot).toMatchObject({ ratio: 0.6 });
	});

	it('drops stale partition resize events', async () => {
		const { coordinator, layout } = createHarness({
			resolvePartitionRatioBounds: () => null,
		});
		const revision = layout.revision;

		await coordinator.setPartitionRatio('partition-missing', 0.7);

		expect(layout.revision).toBe(revision);
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
					type: 'move-tab-to-new-window',
					surfaceId: 'singleton:git',
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-2',
					partitionId: 'partition-1',
				},
				{
					type: 'register-surface',
					surface: { id: terminalSurfaceId('one'), type: 'terminal', terminalId: 'one' },
					windowId: 'window-main',
				},
				{
					type: 'activate-window-tab',
					windowId: 'window-main',
					surfaceId: terminalSurfaceId('one'),
				},
				{
					type: 'register-surface',
					surface: { id: terminalSurfaceId('two'), type: 'terminal', terminalId: 'two' },
					windowId: 'window-2',
				},
			]),
		);

		await coordinator.switchTerminalSurface('one', 'two');

		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(terminalSurfaceId('two'));
		expect(windowTabs(layout.snapshot, 'window-2').order).toContain(terminalSurfaceId('one'));
		expect(
			windowTabs(layout.snapshot, 'window-main').order.filter((id) => id.startsWith('terminal:')),
		).toHaveLength(1);
		expect(
			windowTabs(layout.snapshot, 'window-2').order.filter((id) => id.startsWith('terminal:')),
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
					windowId: 'window-main',
				},
				{
					type: 'activate-window-tab',
					windowId: 'window-main',
					surfaceId: terminalSurfaceId('one'),
				},
			]),
		);

		await coordinator.switchTerminalSurface('one', 'two');

		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(terminalSurfaceId('two'));
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
					windowId: 'window-main',
				},
				{
					type: 'activate-window-tab',
					windowId: 'window-main',
					surfaceId: terminalSurfaceId('one'),
				},
			]),
		);

		await coordinator.createTerminalReplacing('one', 'terminal-surface:one:window-main');

		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(terminalSurfaceId('two'));
		expect(windowTabs(layout.snapshot, 'window-main').order).not.toContain(
			terminalSurfaceId('one'),
		);
		expect(
			windowTabs(layout.snapshot, 'window-main').order.filter((id) => id.startsWith('terminal:')),
		).toHaveLength(1);
		expect(layout.snapshot.unplacedTerminalIds).toContain('one');
		expect(terminals.sessions.one).toBeDefined();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
	});

	it('opens a singleton in a new window and focuses it', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.openSingletonInNewWindow('git-compare');

		expect(windowCountOf(layout.snapshot)).toBe(3);
		const windowId = windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-compare');
		expect(windowId).not.toBe('window-main');
		expect(windowTabs(layout.snapshot, windowId!).activeId).toBe('singleton:git-compare');
		expect(coordinator.lastFocusedSurfaceId).toBe('singleton:git-compare');
	});

	it('focuses an existing singleton that already owns a window instead of opening another', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-compare');
		const windowId = windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-compare')!;
		await coordinator.focusChat();

		await coordinator.openSingletonInNewWindow('git-compare');

		expect(windowCountOf(layout.snapshot)).toBe(3);
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git-compare')).toBe(windowId);
		expect(coordinator.lastFocusedSurfaceId).toBe('singleton:git-compare');
	});

	it('focuses an existing background singleton without creating a new window', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.openSingletonInNewWindow('git');

		expect(windowCountOf(layout.snapshot)).toBe(2);
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:git')).toBe('window-main');
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:git');
	});

	it('rejects new windows beyond the window limit', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		await coordinator.openSingletonInNewWindow('git-compare');
		await coordinator.openSingletonInNewWindow('files');
		for (let index = 4; index < 8; index++) {
			await coordinator.openChatInNewWindow(`capacity-chat-${index}`, 'window-main', 'bottom');
		}
		expect(windowCountOf(layout.snapshot)).toBe(8);

		await expect(coordinator.openSingletonInNewWindow('commit')).rejects.toBeInstanceOf(
			WorkspaceSplitBlockedError,
		);
		expect(layout.surface('singleton:commit')).toBeNull();
	});

	it('rejects a directional Chat move beyond the window limit', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.showChatInCurrentWindow('chat-a');
		await coordinator.openSingletonInNewWindow('git-history');
		await coordinator.openSingletonInNewWindow('git-compare');
		await coordinator.openSingletonInNewWindow('files');
		for (let index = 4; index < 8; index++) {
			await coordinator.openChatInNewWindow(`capacity-chat-${index}`, 'window-main', 'bottom');
		}
		expect(windowCountOf(layout.snapshot)).toBe(8);

		await expect(
			coordinator.moveTabToNewWindow(chatViewSurfaceId('window-main'), 'window-main', 'right'),
		).rejects.toBeInstanceOf(WorkspaceSplitBlockedError);
		expect(layout.surface(chatViewSurfaceId('window-main'))).toMatchObject({ chatId: 'chat-a' });
	});

	it('applies the shared geometry denial to every new-window planner', async () => {
		const resolveSplitAdmission = vi.fn<WorkspaceSplitAdmissionResolver>(() => ({
			allowed: false,
			reason: 'too-small',
		}));
		const { coordinator, layout, terminals } = createHarness({ resolveSplitAdmission });
		terminals.create.mockResolvedValue('terminal-blocked');

		await expect(
			coordinator.openChatInNewWindow('chat-blocked', 'window-main', 'left'),
		).rejects.toMatchObject({ message: 'Not enough space to split this window.' });
		await expect(
			coordinator.openSingletonInNewWindow('git-history', 'window-main'),
		).rejects.toBeInstanceOf(WorkspaceSplitBlockedError);
		await expect(
			coordinator.placeFileSession('file-blocked', {
				type: 'new-window',
				anchorWindowId: 'window-main',
			}),
		).rejects.toBeInstanceOf(WorkspaceSplitBlockedError);
		await expect(
			coordinator.createTerminalInNewWindow('window-main', 'command-menu:new-terminal'),
		).rejects.toBeInstanceOf(WorkspaceSplitBlockedError);
		expect(terminals.create).not.toHaveBeenCalled();
		await expect(
			coordinator.moveTabToNewWindow('singleton:git', 'window-main', 'bottom'),
		).rejects.toBeInstanceOf(WorkspaceSplitBlockedError);

		expect(windowCountOf(layout.snapshot)).toBe(2);
		expect(resolveSplitAdmission).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				targetWindowId: 'window-main',
				edge: 'bottom',
				movingSurfaceId: 'singleton:git',
			}),
		);
	});

	it('lets a keyed terminal retry recover an existing placement after admission closes', async () => {
		let admissionOpen = true;
		const resolveSplitAdmission = vi.fn<WorkspaceSplitAdmissionResolver>(() =>
			admissionOpen ? { allowed: true } : { allowed: false, reason: 'too-small' },
		);
		const { coordinator, layout, terminals } = createHarness({ resolveSplitAdmission });
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

		await expect(
			coordinator.createTerminalInNewWindow('window-main', 'command-menu:new-terminal'),
		).rejects.toThrow('network lost');

		const surfaceId = terminalSurfaceId('terminal-recovered');
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'terminal', terminalId: 'terminal-recovered' },
					windowId: 'window-main',
				},
			]),
		);
		admissionOpen = false;

		await expect(
			coordinator.createTerminalInNewWindow('window-main', 'command-menu:new-terminal'),
		).resolves.toBe('terminal-recovered');

		expect(requestIds[1]).toBe(requestIds[0]);
		expect(resolveSplitAdmission).toHaveBeenCalledTimes(1);
		expect(terminals.requestTermination).not.toHaveBeenCalled();
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, surfaceId)).toBe('window-main');
	});

	it('coalesces concurrent singleton opens into one placement', async () => {
		const { coordinator, layout } = createHarness();

		await Promise.all([
			coordinator.openSingletonAsTab('commit', 'window-main'),
			coordinator.openSingletonAsTab('commit', 'window-main'),
		]);

		expect(
			windowTabs(layout.snapshot, 'window-main').order.filter((id) => id === 'singleton:commit'),
		).toHaveLength(1);
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe('singleton:commit');
	});

	it('lets an in-flight close win over a window-local singleton reopen', async () => {
		const { coordinator, layout, singletons } = createHarness();
		await coordinator.openSingletonAsTab('commit', 'window-main');

		const closing = coordinator.closeSurface('singleton:commit');
		const reopening = coordinator.openSingletonAsTab('commit', 'window-main');
		await Promise.all([closing, reopening]);

		expect(layout.surface('singleton:commit')).toBeNull();
		expect(singletons.disposeSurface).toHaveBeenCalledWith('commit');
	});

	it('applies concurrent singleton destinations against the latest layout', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;

		await Promise.all([
			coordinator.openSingletonAsTab('commit', 'window-main'),
			coordinator.openSingletonAsTab('commit', historyWindowId),
		]);

		expect(windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:commit')).toBe(
			historyWindowId,
		);
		expect(windowTabs(layout.snapshot, historyWindowId).activeId).toBe('singleton:commit');
	});

	it('allows a net-zero edge move at the window limit', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		await coordinator.openSingletonInNewWindow('git-compare');
		await coordinator.openSingletonInNewWindow('files');
		const sourceWindowId = windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:files')!;
		expect(windowCountOf(layout.snapshot)).toBe(4);

		await coordinator.moveTabToNewWindow('singleton:files', 'window-main', 'left');

		expect(windowCountOf(layout.snapshot)).toBe(4);
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:files')).not.toBe(
			sourceWindowId,
		);
	});

	it('treats a sole non-Chat tab moved beside its own window as an identity no-op', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('files');
		const sourceWindowId = windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:files')!;
		const before = layout.snapshot;

		await coordinator.moveTabToNewWindow('singleton:files', sourceWindowId, 'left');

		expect(layout.snapshot).toBe(before);
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, 'singleton:files')).toBe(sourceWindowId);
	});

	it('derives the Terminal launcher only while first-run layout is still canonical', async () => {
		const canonical = createHarness({ includePortableTabs: false });
		await canonical.coordinator.reconcileTerminals([], { deriveLauncher: true });
		expect(windowTabs(canonical.layout.snapshot, 'window-main').order).toContain(
			'terminal-launcher',
		);

		const changed = createHarness();
		await changed.coordinator.focusSurface('singleton:git');
		await changed.coordinator.reconcileTerminals([], { deriveLauncher: true });
		expect(windowTabs(changed.layout.snapshot, 'window-main').order).not.toContain(
			'terminal-launcher',
		);
	});

	it('recovers every live terminal when no terminal placement survived restoration', async () => {
		const { coordinator, layout } = createHarness();

		await coordinator.reconcileTerminals(['one', 'two'], { deriveLauncher: false });

		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(terminalSurfaceId('one'));
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(terminalSurfaceId('two'));
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(CANONICAL_CHAT_SURFACE_ID);
	});

	it('returns to an inactive Chat when mobile terminal reconciliation removes the active tab', async () => {
		const { coordinator, layout, terminals } = createHarness();
		const terminalId = 'mobile-active';
		const surfaceId = terminalSurfaceId(terminalId);
		terminals.sessions[terminalId] = {
			metadata: terminalMetadata(terminalId),
			attachmentState: 'attached',
		};
		await coordinator.openTerminalSession(terminalId, 'window-main');
		await coordinator.focusSurface(surfaceId);
		await coordinator.enterMobilePresentation();

		expect(layout.snapshot.mobileActiveSurfaceId).toBe(surfaceId);
		await coordinator.reconcileTerminals([], { deriveLauncher: false });

		expect(layout.surface(surfaceId)).toBeNull();
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
	});

	it('reuses the launcher Create request ID after an indeterminate response', async () => {
		const { coordinator, terminals, layout } = createHarness({ includePortableTabs: false });
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

		await expect(coordinator.activateTerminalLauncher('window-main')).rejects.toThrow(
			'network lost',
		);
		await expect(coordinator.activateTerminalLauncher('window-main')).resolves.toBeUndefined();

		expect(requestIds[1]).toBe(requestIds[0]);
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(
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
			coordinator.createTerminal('window-main'),
			coordinator.createTerminal('window-main'),
		]);

		expect(new Set(requestIds).size).toBe(2);
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(
			terminalSurfaceId('terminal-1'),
		);
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(
			terminalSurfaceId('terminal-2'),
		);
	});

	it.each(['current window', 'new window'] as const)(
		'keeps a terminal session when its %s surface closes before presentation settles',
		async (destination) => {
			const frames = new SurfaceFrameRegistry();
			const { coordinator, terminals, layout } = createHarness({ surfaceFrames: frames });
			const terminalId = `terminal-close-during-create-${destination.replace(' ', '-')}`;
			const surfaceId = terminalSurfaceId(terminalId);
			terminals.create.mockImplementation(async () => {
				terminals.sessions[terminalId] = {
					metadata: terminalMetadata(terminalId),
					attachmentState: 'attached',
				};
				return terminalId;
			});

			const creating =
				destination === 'current window'
					? coordinator.createTerminal('window-main')
					: coordinator.createTerminalInNewWindow('window-main');
			await vi.waitFor(() => expect(layout.surface(surfaceId)).not.toBeNull());

			await expect(Promise.all([creating, coordinator.closeSurface(surfaceId)])).resolves.toEqual([
				terminalId,
				true,
			]);

			expect(terminals.requestTermination).not.toHaveBeenCalled();
			expect(terminals.disposeTerminatedSession).not.toHaveBeenCalled();
			expect(terminals.sessions[terminalId]).toBeTruthy();
			expect(layout.surface(surfaceId)).toBeNull();
			expect(layout.snapshot.unplacedTerminalIds).toContain(terminalId);
		},
	);

	it.each(['current window', 'new window'] as const)(
		'does not re-present a %s terminal closed during an unchanged publication',
		async (destination) => {
			const terminalId = `terminal-close-during-unchanged-publication-${destination.replace(' ', '-')}`;
			const surfaceId = terminalSurfaceId(terminalId);
			let coordinator: WorkspaceCoordinator | null = null;
			let closeOnPublish = false;
			let closing: Promise<boolean> | null = null;
			const presentSurface = vi.spyOn(WorkspacePresentationController.prototype, 'presentSurface');
			try {
				const harness = createHarness({
					onLayoutChanged: (snapshot) => {
						if (!closeOnPublish || !snapshot.surfaces[surfaceId] || !coordinator) return;
						closeOnPublish = false;
						closing = coordinator.closeSurface(surfaceId);
					},
				});
				coordinator = harness.coordinator;
				const { layout, terminals } = harness;
				terminals.sessions[terminalId] = {
					metadata: terminalMetadata(terminalId),
					attachmentState: 'attached',
				};
				await coordinator.openTerminalSession(terminalId, 'window-main');
				if (destination === 'current window') {
					await coordinator.enterWindowFullscreen('window-main');
				}
				presentSurface.mockClear();
				terminals.create.mockResolvedValue(terminalId);
				closeOnPublish = true;

				const creating =
					destination === 'current window'
						? coordinator.createTerminal('window-main', 'terminal-retry')
						: coordinator.createTerminalInNewWindow('window-main', 'terminal-retry');
				await expect(creating).resolves.toBe(terminalId);
				await expect(closing).resolves.toBe(true);

				expect(layout.surface(surfaceId)).toBeNull();
				expect(layout.snapshot.unplacedTerminalIds).toContain(terminalId);
				expect(presentSurface).not.toHaveBeenCalledWith(surfaceId);
				expect(coordinator.lastFocusedSurfaceId).toBe(CANONICAL_CHAT_SURFACE_ID);
			} finally {
				presentSurface.mockRestore();
			}
		},
	);

	it('removes the launcher when New Terminal is invoked elsewhere without recording dismissal', async () => {
		const onTerminalLauncherDismissed = vi.fn();
		const { coordinator, terminals, layout } = createHarness({
			onTerminalLauncherDismissed,
			includePortableTabs: false,
		});
		await coordinator.reconcileTerminals([], { deriveLauncher: true });
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		terminals.create.mockResolvedValue('terminal-other-window');

		await coordinator.createTerminal(historyWindowId);

		expect(layout.surface('terminal-launcher')).toBeNull();
		expect(windowTabs(layout.snapshot, historyWindowId).order).toContain(
			terminalSurfaceId('terminal-other-window'),
		);
		expect(onTerminalLauncherDismissed).not.toHaveBeenCalled();
	});

	it('honors the requested window when reconciliation places a terminal during creation', async () => {
		const creation = deferred<string>();
		const { coordinator, terminals, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		terminals.create.mockReturnValue(creation.promise);

		const opening = coordinator.createTerminal(
			historyWindowId,
			`workspace-window-titlebar:${historyWindowId}`,
		);
		await vi.waitFor(() => expect(terminals.create).toHaveBeenCalledOnce());
		// Simulate a restored live terminal racing the creation.
		await coordinator.handleTerminalSessionTerminated('terminal-race').catch(() => undefined);
		creation.resolve('terminal-race');
		await opening;

		expect(windowTabs(layout.snapshot, historyWindowId).order).toContain(
			terminalSurfaceId('terminal-race'),
		);
		expect(windowTabs(layout.snapshot, historyWindowId).activeId).toBe(
			terminalSurfaceId('terminal-race'),
		);
	});

	it('falls back when a terminal destination collapses during creation', async () => {
		const creation = deferred<string>();
		const { coordinator, terminals, layout } = createHarness();
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		terminals.create.mockReturnValue(creation.promise);

		const opening = coordinator.createTerminal(historyWindowId);
		await vi.waitFor(() => expect(terminals.create).toHaveBeenCalledOnce());
		await coordinator.closeSurface('singleton:git-history');
		creation.resolve('terminal-stale-window');
		await opening;

		expect(
			windowIdOfSurface(layout.snapshot.desktopRoot, terminalSurfaceId('terminal-stale-window')),
		).toBe('window-main');
	});

	it('does not create desktop window topology when a New Terminal crosses into mobile', async () => {
		const creation = deferred<string>();
		const { coordinator, terminals, layout } = createHarness();
		terminals.create.mockReturnValue(creation.promise);

		const opening = coordinator.createTerminalInNewWindow('window-main');
		await vi.waitFor(() => expect(terminals.create).toHaveBeenCalledOnce());
		await coordinator.enterMobilePresentation();
		creation.resolve('terminal-mobile-transition');
		await opening;

		const surfaceId = terminalSurfaceId('terminal-mobile-transition');
		expect(windowCountOf(layout.snapshot)).toBe(2);
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, surfaceId)).toBe('window-main');
		expect(layout.snapshot.mobileActiveSurfaceId).toBe(surfaceId);
	});

	it('terminates a newly created terminal when its placement cannot publish', async () => {
		const { coordinator, terminals, layout } = createHarness({ failLayoutPublishAt: 1 });
		terminals.create.mockResolvedValue('terminal-unplaced');

		await expect(coordinator.createTerminal('window-main')).rejects.toThrow(
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
		const { coordinator, terminals, layout } = createHarness({
			failLayoutPublishAt: 2,
			includePortableTabs: false,
		});
		await coordinator.reconcileTerminals([], { deriveLauncher: true });
		terminals.create.mockResolvedValue('terminal-unplaced');

		await expect(coordinator.activateTerminalLauncher('window-main')).rejects.toThrow(
			'layout publication failed',
		);

		expect(windowTabs(layout.snapshot, 'window-main').order).toContain('terminal-launcher');
		expect(layout.surface(terminalSurfaceId('terminal-unplaced'))).toBeNull();
		expect(terminals.requestTermination).toHaveBeenCalledWith(
			'terminal-unplaced',
			expect.any(String),
		);
		expect(terminals.disposeTerminatedSession).toHaveBeenCalledWith('terminal-unplaced');
	});

	it('keeps the launcher reserved until a created terminal replaces it', async () => {
		const creation = deferred<string>();
		const { coordinator, terminals, layout } = createHarness({ includePortableTabs: false });
		await coordinator.reconcileTerminals([], { deriveLauncher: true });
		terminals.create.mockImplementation(() => creation.promise);

		const activation = coordinator.activateTerminalLauncher('window-main');
		await Promise.resolve();
		await coordinator.activateTerminalLauncher('window-main');
		await coordinator.reconcileTerminals(['terminal-race'], { deriveLauncher: true });

		expect(terminals.create).toHaveBeenCalledOnce();
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain('terminal-launcher');

		creation.resolve('terminal-race');
		await activation;

		expect(windowTabs(layout.snapshot, 'window-main').order).not.toContain('terminal-launcher');
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(
			terminalSurfaceId('terminal-race'),
		);
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(
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
		await coordinator.openTerminalSession(terminalId, 'window-main');
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
		await coordinator.openSingletonInNewWindow('git-history');
		const historyWindowId = windowIdOfSurface(
			layout.snapshot.desktopRoot,
			'singleton:git-history',
		)!;
		await coordinator.openTerminalSession(terminalId, historyWindowId);

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
		const opening = coordinator.openTerminalSession(terminalId, 'window-main');
		await vi.waitFor(() =>
			expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(surfaceId),
		);
		frames.register(surfaceId, 'window-main', {
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
		await coordinator.openTerminalSession(terminalId, 'window-main');
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
		await coordinator.placeFileSession('source', { type: 'window', windowId: 'window-main' });

		const popOut = coordinator.popOutFile(fileSurfaceId('source'));
		await vi.waitFor(() => expect(confirmDestructive).toHaveBeenCalledOnce());
		await expect(coordinator.closeSurface(fileSurfaceId('source'))).resolves.toBe(false);
		expect(windowTabs(layout.snapshot, 'window-main').order).toContain(fileSurfaceId('source'));

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
		// The canonical Files window becomes visible again on desktop return, so its
		// frame must attach for the transition to settle.
		frames.register('singleton:files', 'window-files', {
			element: document.createElement('div'),
			attachRetainedRenderer: vi.fn(),
			focusPrimary: vi.fn(),
		});
		await exit;

		expect(editor.prepareRendererTransfer).toHaveBeenCalledTimes(2);
		expect(attachMobile).toHaveBeenCalledOnce();
		expect(attachDialog).toHaveBeenCalledOnce();
	});
});
describe('space-aware generic placement', () => {
	const onlyBelow: WorkspaceSplitAdmissionResolver = (_snapshot, { edge }) =>
		edge === 'bottom' ? { allowed: true } : { allowed: false, reason: 'too-small' };

	it('opens a singleton below when the anchor is too narrow to split right', async () => {
		const { coordinator, layout } = createHarness({
			includePortableTabs: false,
			resolveSplitAdmission: onlyBelow,
		});
		await coordinator.openSingletonInNewWindow('git', 'window-main');
		const root = layout.snapshot.desktopRoot;
		expect(root.type).toBe('partition');
		if (root.type !== 'partition') throw new Error('Expected partition');
		const column = root.children[0];
		expect(column.type).toBe('partition');
		if (column.type !== 'partition') throw new Error('Expected nested partition');
		expect(column.direction).toBe('vertical');
		expect(column.children[1].type).toBe('window');
	});

	it.each(['too-small', 'resource-ceiling', 'fullscreen'] as const)(
		'opens a generic view as a tab on %s, without changing explicit new-window behavior',
		async (reason) => {
			const { coordinator, layout } = createHarness({
				includePortableTabs: false,
				resolveSplitAdmission: () => ({ allowed: false, reason }),
			});
			await expect(coordinator.openSingletonInNewWindow('git')).rejects.toThrow(
				WorkspaceSplitBlockedError,
			);
			const count = windowCountOf(layout.snapshot);
			await coordinator.openSingleton('git');
			expect(windowCountOf(layout.snapshot)).toBe(count);
			expect(layout.surface('singleton:git')).not.toBeNull();
			await coordinator.openSingleton('git');
			expect(windowCountOf(layout.snapshot)).toBe(count);
		},
	);

	it('places configured new-window files below the anchor when right is unavailable', async () => {
		const { coordinator, layout } = createHarness({ resolveSplitAdmission: onlyBelow });
		await coordinator.placeFileSession('file-direction', {
			type: 'new-window',
			anchorWindowId: 'window-main',
		});
		expect(windowCountOf(layout.snapshot)).toBe(3);
		expect(
			windowIdOfSurface(layout.snapshot.desktopRoot, fileSurfaceId('file-direction')),
		).not.toBe('window-main');
	});

	it('places a new terminal below the anchor when right is unavailable', async () => {
		const { coordinator, layout } = createHarness({ resolveSplitAdmission: onlyBelow });
		const terminalId = await coordinator.createTerminalInNewWindow('window-main');
		expect(windowCountOf(layout.snapshot)).toBe(3);
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, terminalSurfaceId(terminalId))).not.toBe(
			'window-main',
		);
	});
});
describe('generic terminal creation', () => {
	it('creates one terminal tab when splitting is denied', async () => {
		const { coordinator, layout, terminals } = createHarness({
			resolveSplitAdmission: () => ({ allowed: false, reason: 'too-small' }),
		});
		const terminalId = await coordinator.createTerminalInAvailableSpace('generic-terminal');
		expect(terminals.create).toHaveBeenCalledOnce();
		expect(windowCountOf(layout.snapshot)).toBe(2);
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, terminalSurfaceId(terminalId))).toBe(
			'window-main',
		);
	});
	it('does not turn genuine terminal failures into another creation attempt', async () => {
		const { coordinator, terminals } = createHarness();
		terminals.create.mockRejectedValue(new Error('Terminal unavailable'));
		await expect(coordinator.createTerminalInAvailableSpace()).rejects.toThrow(
			'Terminal unavailable',
		);
		expect(terminals.create).toHaveBeenCalledOnce();
	});
});

describe('responsive window merging', () => {
	it('keeps the current tab, transfers files and terminals, and never invokes close guards', async () => {
		const { coordinator, layout, files, terminals } = createHarness({ includePortableTabs: false });
		await coordinator.openChatInNewWindow('other-chat', 'window-main', 'bottom');
		const chatWindowId = coordinator.currentWindowId;
		await coordinator.placeFileSession('dirty', { type: 'window', windowId: chatWindowId });
		const terminalId = await coordinator.createTerminal(chatWindowId);
		await coordinator.focusSurface(CANONICAL_CHAT_SURFACE_ID);
		const selected = windowTabs(layout.snapshot, 'window-main').activeId;
		await expect(coordinator.fitWindowsToHost(() => ({ width: 300, height: 200 }))).resolves.toBe(
			true,
		);
		expect(windowCountOf(layout.snapshot)).toBe(1);
		expect(coordinator.currentWindowId).toBe('window-main');
		expect(windowTabs(layout.snapshot, 'window-main').activeId).toBe(selected);
		expect(windowTabs(layout.snapshot, 'window-main').order).toEqual(
			expect.arrayContaining([
				'singleton:files',
				fileSurfaceId('dirty'),
				terminalSurfaceId(terminalId),
			]),
		);
		expect(coordinator.closeGuardRequest).toBeNull();
		expect(files.confirmDestructive).not.toHaveBeenCalled();
		expect(terminals.requestTermination).not.toHaveBeenCalled();
		const revision = layout.revision;
		await coordinator.fitWindowsToHost(() => ({ width: 2400, height: 1200 }));
		expect(layout.revision).toBe(revision);
		expect(windowCountOf(layout.snapshot)).toBe(1);
	});
	it('transfers the last Chat view into a non-Chat current window without selecting it', async () => {
		const { coordinator, layout } = createHarness({ includePortableTabs: false });
		await coordinator.showChatInCurrentWindow('retained-chat');
		await coordinator.focusSurface('singleton:files');
		const publication = { publish: vi.fn(), rollback: vi.fn() };
		const transfer = vi.fn(() => publication);
		coordinator.registerChatSurfaceTransferPort({ prepareChatSurfaceTransfer: transfer });
		await coordinator.fitWindowsToHost(() => ({ width: 300, height: 200 }));
		expect(coordinator.currentWindowId).toBe('window-files');
		expect(windowTabs(layout.snapshot, 'window-files').activeId).toBe('singleton:files');
		expect(layout.surface(chatViewSurfaceId('window-files'))).toMatchObject({
			chatId: 'retained-chat',
		});
		expect(transfer).toHaveBeenCalledOnce();
		expect(publication.publish).toHaveBeenCalledOnce();
	});
	it('does not prune fullscreen, mobile, or an unmeasured host', async () => {
		const { coordinator, layout } = createHarness();
		await coordinator.fitWindowsToHost(() => null);
		expect(windowCountOf(layout.snapshot)).toBe(2);
		await coordinator.enterWindowFullscreen('window-main');
		await coordinator.fitWindowsToHost(() => ({ width: 1, height: 1 }));
		expect(windowCountOf(layout.snapshot)).toBe(2);
		await coordinator.enterMobilePresentation();
		await coordinator.fitWindowsToHost(() => ({ width: 1, height: 1 }));
		expect(windowCountOf(layout.snapshot)).toBe(2);
	});
	it('defers a merge while a close guard owns a source and succeeds after cancellation', async () => {
		const guard = deferred<boolean>();
		const { coordinator, layout } = createHarness({ confirmDestructive: () => guard.promise });
		await coordinator.placeFileSession('guarded', { type: 'window', windowId: 'window-files' });
		const closing = coordinator.closeSurface(fileSurfaceId('guarded'));
		await Promise.resolve();
		await expect(coordinator.fitWindowsToHost(() => ({ width: 300, height: 200 }))).resolves.toBe(
			false,
		);
		expect(windowCountOf(layout.snapshot)).toBe(2);
		guard.resolve(false);
		await closing;
		await coordinator.fitWindowsToHost(() => ({ width: 300, height: 200 }));
		expect(windowCountOf(layout.snapshot)).toBe(1);
		expect(layout.surface(fileSurfaceId('guarded'))).not.toBeNull();
	});
});
