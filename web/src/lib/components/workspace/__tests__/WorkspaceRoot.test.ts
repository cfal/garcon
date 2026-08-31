import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalWorkspaceSnapshot } from '$lib/workspace/canonical-layout.js';
import {
	WorkspaceLayoutStore,
	reduceWorkspaceLayout,
} from '$lib/workspace/workspace-layout.svelte.js';
import { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
import { SurfaceFrameRegistry } from '$lib/workspace/surface-frame-registry.svelte.js';
import {
	chatViewSurfaceId,
	portableSingletonDescriptor,
	terminalSurfaceId,
	type FocusOwner,
	type PortableSingletonKind,
	type WorkspaceLayoutMutation,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
} from '$lib/workspace/surface-types.js';
import { collectWindowNodes, windowIdOfSurface } from '$lib/workspace/window-tree.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { TerminalClientSession } from '$lib/terminal/sessions/terminal-registry.svelte.js';
import * as m from '$lib/paraglide/messages.js';

const testContext = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('$lib/context', () => ({
	getAppShell: () => testContext.current?.appShell,
	getChatSessions: () => testContext.current?.sessions,
	getFileSessions: () => testContext.current?.fileSessions,
	getGhCapability: () => testContext.current?.ghCapability,
	getGitBranchActions: () => testContext.current?.gitBranchActions,
	getLocalSettings: () => testContext.current?.localSettings,
	getGitQuickSummary: () => testContext.current?.gitQuickSummary,
	getChatProcessingReconciler: () => testContext.current?.processingReconciler,
	getConversationPanels: () => testContext.current?.conversationPanels,
	getModelCatalog: () => testContext.current?.modelCatalog,
	getNotifications: () => testContext.current?.notifications,
	getSurfaceFrames: () => testContext.current?.surfaceFrames,
	getTerminalRegistry: () => testContext.current?.terminals,
	getWorkspaceCoordinator: () => testContext.current?.workspace,
	getWorkspaceWindowDnd: () => testContext.current?.windowDnd,
	getOptionalTransientLayers: () => null,
	setConversationUi: (value: unknown) => {
		if (testContext.current) testContext.current.conversationUi = value;
	},
	setConversationLifecycles: (value: unknown) => {
		if (testContext.current) testContext.current.conversationLifecycles = value;
	},
	setConversationPanels: (value: unknown) => {
		if (testContext.current) testContext.current.conversationPanels = value;
	},
}));

vi.mock('$lib/components/chat/ChatSurface.svelte', async () => ({
	default: (await import('./ChatSurfaceTestStub.svelte')).default,
}));
vi.mock('$lib/components/chat/ConversationPanel.svelte', async () => ({
	default: (await import('./ConversationPanelTestStub.svelte')).default,
}));
vi.mock('$lib/components/workspace/PortableSurfaceContent.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));
vi.mock('$lib/api/chats.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/chats.js')>();
	return {
		...actual,
		getChatMessages: vi.fn(async (request) => ({
			historyState: { kind: 'complete' as const },
			chatId: request.chatId,
			transcriptViewId: `view-${request.chatId}`,
			messages: [],
			lastOrdinal: 0,
			pageOldestOrdinal: 0,
			pageNewestOrdinal: 0,
			nextBeforeOrdinal: null,
			hasMore: false,
			limit: request.limit ?? 50,
			resendCandidates: [],
		})),
	};
});

const WorkspaceRoot = (await import('../WorkspaceRoot.svelte')).default;

function chat(id: string, title: string): ChatSessionRecord {
	return {
		id,
		parentChat: null,
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title,
		agentId: 'codex',
		model: 'default',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'draft',
		agentOwnershipEpoch: null,
		tags: [],
	};
}

function installContext() {
	const initial = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
		{ type: 'set-window-chat', windowId: 'window-main', chatId: 'chat-a' },
	]);
	const layout = new WorkspaceLayoutStore(initial);
	const runtime: {
		currentWindowId: WorkspaceWindowId;
		focusOwner: FocusOwner;
		composerAnchorSurfaceId: ReturnType<typeof chatViewSurfaceId> | null;
	} = {
		currentWindowId: 'window-main' as WorkspaceWindowId,
		focusOwner: { kind: 'surface' as const, surfaceId: chatViewSurfaceId('window-main') },
		composerAnchorSurfaceId: chatViewSurfaceId('window-main'),
	};
	const commit = (mutations: readonly WorkspaceLayoutMutation[]): void => {
		const next = reduceWorkspaceLayout(layout.snapshot, mutations);
		if (!layout.publish(layout.revision, next)) throw new Error('Test publication failed');
	};
	const focusSurface = vi.fn(async (surfaceId: string) => {
		const windowId = windowIdOfSurface(layout.snapshot.desktopRoot, surfaceId);
		if (!windowId) return;
		runtime.currentWindowId = windowId;
		runtime.focusOwner = { kind: 'surface', surfaceId };
		const surface = layout.snapshot.surfaces[surfaceId];
		if (surface?.type === 'chat') {
			runtime.composerAnchorSurfaceId = surfaceId as ReturnType<typeof chatViewSurfaceId>;
			const sessions = testContext.current?.sessions as
				| {
						selectedChatId: string | null;
						selectedChat: ChatSessionRecord | null;
						byId: Record<string, ChatSessionRecord>;
				  }
				| undefined;
			if (sessions && surface.chatId) {
				sessions.selectedChatId = surface.chatId;
				sessions.selectedChat = sessions.byId[surface.chatId] ?? null;
			}
		}
		commit([{ type: 'activate-window-tab', windowId, surfaceId }]);
	});
	const activateWindow = vi.fn((windowId: WorkspaceWindowId) => {
		const workspaceWindow = collectWindowNodes(layout.snapshot.desktopRoot).find(
			(item) => item.id === windowId,
		);
		if (!workspaceWindow) return;
		runtime.currentWindowId = windowId;
		commit([
			{
				type: 'activate-window-tab',
				windowId,
				surfaceId: workspaceWindow.tabs.activeId,
			},
		]);
	});
	const workspace = {
		layout,
		attachmentErrors: {} as Record<string, string>,
		get currentWindowId() {
			void layout.revision;
			return runtime.currentWindowId;
		},
		get focusOwner() {
			void layout.revision;
			return runtime.focusOwner;
		},
		get composerAnchorSurfaceId() {
			void layout.revision;
			return runtime.composerAnchorSurfaceId;
		},
		get defaultWindowId() {
			return layout.defaultWindowId;
		},
		get windowCount() {
			return collectWindowNodes(layout.snapshot.desktopRoot).length;
		},
		get isChatInteractive() {
			return true;
		},
		frameVersion: () => 0,
		windowOf: (surfaceId: string) => windowIdOfSurface(layout.snapshot.desktopRoot, surfaceId),
		noteSurfaceFocus: vi.fn((surfaceId: string) => {
			const windowId = windowIdOfSurface(layout.snapshot.desktopRoot, surfaceId);
			if (windowId) {
				runtime.currentWindowId = windowId;
				runtime.focusOwner = { kind: 'surface', surfaceId };
			}
			if (layout.snapshot.surfaces[surfaceId]?.type === 'chat') {
				runtime.composerAnchorSurfaceId = surfaceId as ReturnType<typeof chatViewSurfaceId>;
			}
		}),
		noteWindowChromeFocus: vi.fn((windowId: WorkspaceWindowId) => {
			runtime.currentWindowId = windowId;
		}),
		activateWindow,
		beginWindowPointerInteraction: vi.fn((windowId: WorkspaceWindowId) => {
			const activeId = collectWindowNodes(layout.snapshot.desktopRoot).find(
				(item) => item.id === windowId,
			)?.tabs.activeId;
			if (!activeId) return;
			runtime.currentWindowId = windowId;
			runtime.focusOwner = { kind: 'surface', surfaceId: activeId };
		}),
		commitWindowPointerInteraction: vi.fn((windowId: WorkspaceWindowId) => {
			const activeId = collectWindowNodes(layout.snapshot.desktopRoot).find(
				(item) => item.id === windowId,
			)?.tabs.activeId;
			if (!activeId) return;
			runtime.currentWindowId = windowId;
			runtime.focusOwner = { kind: 'surface', surfaceId: activeId };
			if (layout.snapshot.surfaces[activeId]?.type === 'chat') {
				runtime.composerAnchorSurfaceId = activeId as ReturnType<typeof chatViewSurfaceId>;
			}
		}),
		releaseWindowPointerInteraction: vi.fn(),
		cancelWindowPointerInteraction: vi.fn(),
		focusSurface,
		isWindowCloseBlocked: (windowId: WorkspaceWindowId) =>
			collectWindowNodes(layout.snapshot.desktopRoot).length === 1 ||
			!collectWindowNodes(layout.snapshot.desktopRoot).some((item) => item.id === windowId),
		isSurfaceCloseBlocked: () => false,
		closeSurface: vi.fn(async (surfaceId: string) => {
			commit([{ type: 'remove-surface', surfaceId }]);
			return true;
		}),
		closeWindow: vi.fn(async (windowId: WorkspaceWindowId) => {
			commit([{ type: 'close-window', windowId }]);
			runtime.currentWindowId = layout.defaultWindowId;
			return true;
		}),
		enterWindowFullscreen: vi.fn(async (windowId: WorkspaceWindowId) => {
			commit([{ type: 'set-fullscreen-window', windowId }]);
			runtime.currentWindowId = windowId;
			return true;
		}),
		exitWindowFullscreen: vi.fn(async () => {
			commit([{ type: 'set-fullscreen-window', windowId: null }]);
		}),
		setPartitionRatio: vi.fn(async () => undefined),
		moveTabToWindow: vi.fn(
			async (surfaceId: string, destinationWindowId: WorkspaceWindowId, index?: number) => {
				commit([{ type: 'move-tab', surfaceId, destinationWindowId, index }]);
			},
		),
		moveTabToNewWindow: vi.fn(
			async (surfaceId: string, targetWindowId: WorkspaceWindowId, edge: WorkspaceWindowEdge) => {
				commit([
					{
						type: 'move-tab-to-new-window',
						surfaceId,
						targetWindowId,
						edge,
						newWindowId: 'window-dropped',
						partitionId: 'partition-dropped',
					},
				]);
			},
		),
		showChatInWindow: vi.fn(async (chatId: string, windowId: WorkspaceWindowId) => {
			commit([{ type: 'set-window-chat', windowId, chatId }]);
			runtime.currentWindowId = windowId;
			return chatViewSurfaceId(windowId);
		}),
		openChatInNewWindow: vi.fn(
			async (chatId: string, targetWindowId: WorkspaceWindowId, edge: WorkspaceWindowEdge) => {
				commit([
					{
						type: 'open-chat-in-new-window',
						chatId,
						targetWindowId,
						edge,
						newWindowId: 'window-chat-drop',
						partitionId: 'partition-chat-drop',
					},
				]);
				return 'window-chat-drop' as WorkspaceWindowId;
			},
		),
		openSingletonAsTab: vi.fn(async (kind: PortableSingletonKind, windowId: WorkspaceWindowId) => {
			const surfaceId = `singleton:${kind}`;
			const descriptor = layout.snapshot.surfaces[surfaceId];
			commit(
				descriptor
					? [{ type: 'move-tab', surfaceId, destinationWindowId: windowId }]
					: [{ type: 'register-surface', surface: portableSingletonDescriptor(kind), windowId }],
			);
		}),
		createTerminal: vi.fn(async () => 'terminal-created'),
		terminateTerminalSession: vi.fn(async () => true),
		openTerminalSession: vi.fn(async () => undefined),
		retryPresentation: vi.fn(async () => undefined),
		mobileBack: vi.fn(async () => undefined),
		focusChat: vi.fn(async () => undefined),
	};
	const terminals = {
		orderedSessions: [] as TerminalClientSession[],
		sessions: {} as Record<string, TerminalClientSession>,
		listStatus: 'ready' as const,
		ensureRuntime: vi.fn(() => ({
			clipboardMessage: '',
			pasteFromClipboard: vi.fn(async () => true),
		})),
		reattach: vi.fn(),
		rename: vi.fn(async (_terminalId: string, _title: string | null) => undefined),
	};
	const localSettings = {
		terminalFontSize: '13',
		set: vi.fn(),
	};
	const windowDnd = new WorkspaceWindowDndController(layout);
	testContext.current = {
		appShell: { isMobile: false, openNewChatDialog: vi.fn() },
		workspace,
		windowDnd,
		surfaceFrames: new SurfaceFrameRegistry(),
		fileSessions: { get: () => null },
		terminals,
		localSettings,
		sessions: {
			selectedChatId: 'chat-a',
			selectedChat: chat('chat-a', 'Chat A'),
			byId: { 'chat-a': chat('chat-a', 'Chat A'), 'chat-b': chat('chat-b', 'Chat B') },
			isLoadingChats: false,
			isChatProcessing: () => false,
			processingPhase: () => null,
		},
		processingReconciler: { addPresentation: () => () => {} },
		modelCatalog: {
			supportsFork: () => false,
			supportsForkWhileRunning: () => false,
			supportsUpdateProjectPath: () => false,
		},
		gitBranchActions: { showNewBranchModal: false },
		gitQuickSummary: {
			isEnabled: true,
			setVisibleProjects: vi.fn(),
			reconcilePolling: vi.fn(),
		},
		ghCapability: { hasChecked: true, available: true },
		notifications: { error: vi.fn() },
	};
	return { layout, runtime, workspace, windowDnd, terminals, localSettings };
}

const chatActions = {
	requestDelete: vi.fn(),
	requestRename: vi.fn(),
	requestDetails: vi.fn(),
	requestShare: vi.fn(),
	requestProjectPath: vi.fn(),
	fork: vi.fn(),
	reload: vi.fn(),
};

function renderRoot(isMobile = false) {
	return render(WorkspaceRoot, { isMobile, chatActions });
}

function positionedDragEvent(type: string, clientX: number, clientY: number): DragEvent {
	const event = new DragEvent(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: clientX },
		clientY: { value: clientY },
	});
	return event;
}

describe('WorkspaceRoot', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('ResizeObserver', undefined);
	});

	afterEach(() => {
		cleanup();
		testContext.current = null;
		vi.unstubAllGlobals();
	});

	it('renders one in-flow title bar per window and no global tab list', () => {
		installContext();
		const { container } = renderRoot();

		expect(container.querySelectorAll('[data-workspace-window-titlebar]')).toHaveLength(1);
		expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
		expect(screen.getByRole('tab', { name: 'Chat A' }).getAttribute('draggable')).toBe('true');
		expect(container.querySelector('[data-workspace-window-close]')).toBeNull();
		const panel = container.querySelector(
			'[data-workspace-surface-id="chat-view:window-main"]',
		) as HTMLElement;
		expect(panel.tabIndex).toBe(-1);
		expect(panel.getAttribute('aria-labelledby')).toBe('window-main-tab-chat-view:window-main');
		expect(document.getElementById('window-main-tab-chat-view:window-main')).not.toBeNull();
		expect(container.querySelector('[data-workspace-window-focus-ring]')).toBeNull();
	});

	it('adds active terminal actions to the window menu', async () => {
		const { layout, workspace, terminals } = installContext();
		const terminalId = 'terminal-1';
		const surfaceId = terminalSurfaceId(terminalId);
		const terminal: TerminalClientSession = {
			metadata: {
				terminalId,
				displaySequence: 1,
				title: 'Dev server',
				initialWorkingDirectory: '/workspace/project',
				processStatus: 'running',
				attachmentStatus: 'attached',
				createdAt: '2026-08-31T00:00:00.000Z',
				exitCode: null,
				latestOutputSequence: 0,
			},
			attachmentState: 'attached',
			lastReceivedSequence: 0,
			replayTruncatedAt: null,
		};
		terminals.sessions[terminalId] = terminal;
		terminals.orderedSessions = [terminal];
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface',
					surface: { id: surfaceId, type: 'terminal', terminalId },
					windowId: 'window-main',
				},
				{
					type: 'activate-window-tab',
					windowId: 'window-main',
					surfaceId,
				},
			]),
		);
		renderRoot();
		expect(screen.getByRole('tab', { name: 'Dev server' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));

		expect(screen.getByRole('menuitem', { name: m.terminal_rename() })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: m.terminal_paste() })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: /Font size 13px/ })).toBeTruthy();
		await fireEvent.click(screen.getByRole('menuitem', { name: m.terminal_rename() }));
		const renameInput = await screen.findByRole('textbox', { name: m.terminal_name() });
		expect((renameInput as HTMLInputElement).value).toBe('Dev server');
		await fireEvent.input(renameInput, { target: { value: 'Build logs' } });
		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_save() }));
		await waitFor(() => expect(terminals.rename).toHaveBeenCalledWith(terminalId, 'Build logs'));

		await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));
		await fireEvent.click(screen.getByRole('menuitem', { name: m.terminal_terminate() }));
		expect(workspace.terminateTerminalSession).toHaveBeenCalledWith(terminalId);
	});

	it('labels an occupied Chat center drop as replacement', async () => {
		const { layout, windowDnd } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'open-chat-in-new-window',
					chatId: 'chat-b',
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-2',
					partitionId: 'partition-1',
				},
			]),
		);
		const { container } = renderRoot();
		const sourceTab = screen.getByRole('tab', { name: 'Chat A' });
		const destination = container.querySelector(
			'[data-workspace-window-id="window-2"]',
		) as HTMLElement;
		vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
		windowDnd.beginSurfaceTabDrag(
			chatViewSurfaceId('window-main'),
			'window-main',
			0,
			positionedDragEvent('dragstart', 0, 0),
		);
		await tick();

		await fireEvent(destination, positionedDragEvent('dragover', 50, 50));

		expect(sourceTab.getAttribute('draggable')).toBe('true');
		expect(
			container.querySelector('[data-workspace-window-drop-result]')?.textContent?.trim(),
		).toBe(m.workspace_drop_zone_replace_chat());
	});

	it('adds a sidebar Chat to the exact Chat-less center destination', async () => {
		const { layout, windowDnd, workspace } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface-in-new-window',
					surface: portableSingletonDescriptor('files'),
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-files',
					partitionId: 'partition-files',
				},
			]),
		);
		const { container } = renderRoot();
		const destination = container.querySelector(
			'[data-workspace-window-id="window-files"]',
		) as HTMLElement;
		vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
		windowDnd.beginChatDrag('chat-b');
		await tick();

		await fireEvent(destination, positionedDragEvent('dragover', 50, 50));
		expect(
			destination.querySelector('[data-workspace-window-drop-result]')?.textContent?.trim(),
		).toBe(m.workspace_drop_zone_add_tab());
		await fireEvent(destination, positionedDragEvent('drop', 50, 50));

		await waitFor(() =>
			expect(workspace.showChatInWindow).toHaveBeenCalledWith('chat-b', 'window-files'),
		);
		expect(layout.surface(chatViewSurfaceId('window-files'))).toMatchObject({ chatId: 'chat-b' });
		expect(windowIdOfSurface(layout.snapshot.desktopRoot, chatViewSurfaceId('window-files'))).toBe(
			'window-files',
		);
		expect(collectWindowNodes(layout.snapshot.desktopRoot)).toHaveLength(2);
	});

	it('replaces a sidebar Chat in the exact occupied center destination', async () => {
		const { layout, windowDnd, workspace } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'open-chat-in-new-window',
					chatId: 'chat-b',
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-2',
					partitionId: 'partition-1',
				},
			]),
		);
		const { container } = renderRoot();
		const destination = container.querySelector(
			'[data-workspace-window-id="window-2"]',
		) as HTMLElement;
		vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
		windowDnd.beginChatDrag('chat-a');
		await tick();

		await fireEvent(destination, positionedDragEvent('dragover', 50, 50));
		expect(
			destination.querySelector('[data-workspace-window-drop-result]')?.textContent?.trim(),
		).toBe(m.workspace_drop_zone_replace_chat());
		await fireEvent(destination, positionedDragEvent('drop', 50, 50));

		await waitFor(() =>
			expect(workspace.showChatInWindow).toHaveBeenCalledWith('chat-a', 'window-2'),
		);
		expect(layout.surface(chatViewSurfaceId('window-2'))).toMatchObject({ chatId: 'chat-a' });
		expect(collectWindowNodes(layout.snapshot.desktopRoot)).toHaveLength(2);
	});

	it('keeps one live Chat surface mounted while its local tab becomes hidden', async () => {
		const { layout, workspace } = installContext();
		const { container } = renderRoot();
		const liveChat = screen.getByTestId('chat-surface-stub');
		const composerLayer = container.querySelector('[data-workspace-live-chat-body]')?.parentElement;
		if (!composerLayer) throw new Error('Expected composer layer');

		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface',
					surface: portableSingletonDescriptor('git'),
					windowId: 'window-main',
				},
				{
					type: 'activate-window-tab',
					windowId: 'window-main',
					surfaceId: 'singleton:git',
				},
			]),
		);
		await tick();

		expect(screen.getByTestId('chat-surface-stub')).toBe(liveChat);
		expect(liveChat.getAttribute('data-visible')).toBe('false');
		expect(composerLayer.getAttribute('aria-hidden')).toBe('true');
		expect(composerLayer.hasAttribute('inert')).toBe(true);
		expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
		const chatTab = screen.getByRole('tab', { name: 'Chat A' });
		const chatPanelId = chatTab.getAttribute('aria-controls');
		expect(chatPanelId).not.toBeNull();
		expect(document.getElementById(chatPanelId!)).not.toBeNull();
		expect(document.getElementById(chatPanelId!)?.getAttribute('aria-hidden')).toBe('true');
		await workspace.focusSurface(chatViewSurfaceId('window-main'));
		await tick();
		expect(screen.getByTestId('chat-surface-stub')).toBe(liveChat);
		expect(liveChat.getAttribute('data-visible')).toBe('true');
		expect(composerLayer.getAttribute('aria-hidden')).toBe('false');
		expect(composerLayer.hasAttribute('inert')).toBe(false);
	});

	it('keeps one runtime while both windows render the same conversation panel', async () => {
		const { layout, workspace } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'open-chat-in-new-window',
					chatId: 'chat-b',
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-2',
					partitionId: 'partition-1',
				},
			]),
		);
		const { container } = renderRoot();
		const liveChat = screen.getByTestId('chat-surface-stub');
		const liveChatBody = container.querySelector('[data-workspace-live-chat-body]')!;
		const panelA = screen
			.getAllByTestId('conversation-panel')
			.find((panel) => panel.dataset.chatId === 'chat-a')!;
		const panelB = screen
			.getAllByTestId('conversation-panel')
			.find((panel) => panel.dataset.chatId === 'chat-b')!;
		expect(panelA.dataset.commandOwner).toBe('true');
		expect(panelA.dataset.ownsComposer).toBe('true');
		expect(panelB.dataset.commandOwner).toBe('false');
		expect(panelB.dataset.ownsComposer).toBe('false');
		expect(liveChatBody.classList.contains('top-10')).toBe(true);
		expect(liveChatBody.classList.contains('inset-0')).toBe(false);
		expect(container.querySelector('[data-workspace-window-focus-ring]')).toBeNull();

		await workspace.focusSurface(chatViewSurfaceId('window-2'));
		await tick();

		expect(screen.getByTestId('chat-surface-stub')).toBe(liveChat);
		expect(screen.getAllByTestId('conversation-panel')).toEqual(
			expect.arrayContaining([panelA, panelB]),
		);
		expect(panelA.dataset.commandOwner).toBe('false');
		expect(panelA.dataset.ownsComposer).toBe('false');
		expect(panelB.dataset.commandOwner).toBe('true');
		expect(panelB.dataset.ownsComposer).toBe('true');
		expect(liveChatBody.classList.contains('top-10')).toBe(true);
		expect(container.querySelectorAll('[data-workspace-window-titlebar]')).toHaveLength(2);
	});

	it('keeps one composer mounted and hidden during anchor-selection reconciliation', async () => {
		const { layout, runtime } = installContext();
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
		const { container } = renderRoot();
		const composer = screen.getByTestId('chat-surface-stub');
		const composerLayer = container.querySelector('[data-workspace-live-chat-body]')?.parentElement;
		if (!composerLayer) throw new Error('Expected composer layer');
		const sessions = testContext.current?.sessions as {
			selectedChatId: string | null;
			selectedChat: ChatSessionRecord | null;
			byId: Record<string, ChatSessionRecord>;
		};

		sessions.selectedChatId = 'chat-b';
		sessions.selectedChat = sessions.byId['chat-b'];
		layout.publish(layout.revision, { ...layout.snapshot });
		await tick();

		expect(screen.getByTestId('chat-surface-stub')).toBe(composer);
		expect(composer.dataset.visible).toBe('false');
		expect(composerLayer.getAttribute('aria-hidden')).toBe('true');
		expect(composerLayer.hasAttribute('inert')).toBe(true);

		runtime.composerAnchorSurfaceId = chatViewSurfaceId('window-chat');
		layout.publish(layout.revision, { ...layout.snapshot });
		await tick();

		expect(screen.getByTestId('chat-surface-stub')).toBe(composer);
		expect(composer.dataset.visible).toBe('true');
		expect(composerLayer.getAttribute('aria-hidden')).toBe('false');
		expect(composerLayer.hasAttribute('inert')).toBe(false);
	});

	it('lets the first pointer gesture act in a visible Files pane without moving the composer', async () => {
		const { layout, runtime, workspace } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface-in-new-window',
					surface: portableSingletonDescriptor('files'),
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-files',
					partitionId: 'partition-files',
				},
			]),
		);
		const { container } = renderRoot();
		const filesWindow = container.querySelector<HTMLElement>(
			'[data-workspace-window-id="window-files"]',
		)!;
		const filesContent = filesWindow.querySelector<HTMLElement>(
			'[data-workspace-window-content]',
		)!;
		const filesRenderer = filesWindow.querySelector<HTMLElement>(
			'[data-testid="surface-renderer-stub"]',
		)!;
		const clicked = vi.fn();
		const wheeled = vi.fn();
		const contextMenu = vi.fn();
		filesRenderer.addEventListener('click', clicked);
		filesRenderer.addEventListener('wheel', wheeled);
		filesRenderer.addEventListener('contextmenu', contextMenu);

		expect(filesContent.hasAttribute('inert')).toBe(false);
		expect(filesContent.hasAttribute('aria-hidden')).toBe(false);
		expect(filesWindow.querySelector('[data-workspace-window-activation-shield]')).toBeNull();
		expect(screen.getByTestId('chat-surface-stub').dataset.visible).toBe('true');

		await fireEvent.pointerDown(filesRenderer, { pointerId: 1, button: 0 });
		await fireEvent.pointerUp(filesRenderer, { pointerId: 1, button: 0 });
		await fireEvent.click(filesRenderer);
		await tick();

		expect(clicked).toHaveBeenCalledOnce();
		expect(workspace.beginWindowPointerInteraction).toHaveBeenCalledWith('window-files', 1);
		expect(workspace.releaseWindowPointerInteraction).toHaveBeenCalledWith('window-files', 1);
		expect(workspace.commitWindowPointerInteraction).toHaveBeenCalledWith('window-files');
		expect(runtime.currentWindowId).toBe('window-files');
		expect(runtime.composerAnchorSurfaceId).toBe(chatViewSurfaceId('window-main'));
		expect(screen.getByTestId('chat-surface-stub').dataset.visible).toBe('true');

		await fireEvent.wheel(filesRenderer, { deltaY: 100 });
		expect(wheeled).toHaveBeenCalledOnce();
		expect(runtime.currentWindowId).toBe('window-files');
		await fireEvent.contextMenu(filesRenderer);
		expect(contextMenu).toHaveBeenCalledOnce();
	});

	it('restores Chat ownership from the detached composer without opening a window gesture', async () => {
		const { layout, runtime, workspace } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface-in-new-window',
					surface: portableSingletonDescriptor('files'),
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-files',
					partitionId: 'partition-files',
				},
			]),
		);
		const { container } = renderRoot();
		const filesRenderer = container.querySelector<HTMLElement>(
			'[data-workspace-window-id="window-files"] [data-testid="surface-renderer-stub"]',
		)!;
		await fireEvent.pointerDown(filesRenderer, { pointerId: 1, button: 0 });
		await fireEvent.pointerUp(filesRenderer, { pointerId: 1, button: 0 });
		await fireEvent.click(filesRenderer);
		expect(runtime.currentWindowId).toBe('window-files');

		vi.mocked(workspace.noteSurfaceFocus).mockClear();
		vi.mocked(workspace.beginWindowPointerInteraction).mockClear();
		const composerBody = container.querySelector<HTMLElement>('[data-workspace-live-chat-body]')!;
		await fireEvent.pointerDown(composerBody, { pointerId: 2, button: 0 });

		expect(workspace.noteSurfaceFocus).toHaveBeenCalledWith(chatViewSurfaceId('window-main'));
		expect(workspace.beginWindowPointerInteraction).not.toHaveBeenCalled();
		expect(runtime.currentWindowId).toBe('window-main');
	});

	it('releases a pane pointer interaction when pointer-up lands outside its window', async () => {
		const { layout, workspace } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface-in-new-window',
					surface: portableSingletonDescriptor('files'),
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-files',
					partitionId: 'partition-files',
				},
			]),
		);
		const { container } = renderRoot();
		const filesRenderer = container.querySelector<HTMLElement>(
			'[data-workspace-window-id="window-files"] [data-testid="surface-renderer-stub"]',
		)!;

		await fireEvent.pointerDown(filesRenderer, { pointerId: 9, button: 0 });
		await fireEvent.pointerUp(document.body, { pointerId: 9, button: 0 });

		expect(workspace.releaseWindowPointerInteraction).toHaveBeenCalledWith('window-files', 9);
	});

	it('lets the first click invoke an explicitly targeted action in another Chat panel', async () => {
		const { layout, runtime } = installContext();
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
		renderRoot();
		const panelB = screen
			.getAllByTestId('conversation-panel')
			.find((panel) => panel.dataset.chatId === 'chat-b');
		if (!panelB) throw new Error('Expected Chat B panel');

		await fireEvent.pointerDown(panelB, { pointerId: 7, button: 0 });
		await fireEvent.pointerUp(panelB, { pointerId: 7, button: 0 });
		await fireEvent.click(panelB);
		await tick();

		expect(screen.getByTestId('chat-surface-stub').dataset.panelAction).toBe(
			'chat-view:window-chat:chat-b:pause',
		);
		expect(runtime.currentWindowId).toBe('window-chat');
		expect(runtime.composerAnchorSurfaceId).toBe(chatViewSurfaceId('window-chat'));
	});

	it('renders only the active mobile conversation panel in mobile mode', () => {
		const { layout } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'open-chat-in-new-window',
					chatId: 'chat-b',
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-2',
					partitionId: 'partition-1',
				},
			]),
		);

		renderRoot(true);

		expect(screen.getAllByTestId('conversation-panel')).toHaveLength(1);
		expect(screen.getByTestId('conversation-panel').dataset.chatId).toBe('chat-a');
		expect(screen.getByTestId('chat-surface-stub').dataset.visible).toBe('true');
	});

	it('fullscreen hides other windows and restores their exact keyed layout on exit', async () => {
		const { layout } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface-in-new-window',
					surface: portableSingletonDescriptor('git'),
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-2',
					partitionId: 'partition-1',
				},
			]),
		);
		const { container } = renderRoot();
		const beforeRoot = layout.snapshot.desktopRoot;
		const mainWindow = container.querySelector('[data-workspace-window-id="window-main"]')!;
		const gitWindow = container.querySelector('[data-workspace-window-id="window-2"]')!;
		const composerLayer = container.querySelector('[data-workspace-live-chat-body]')?.parentElement;
		if (!composerLayer) throw new Error('Expected composer layer');
		expect(container.querySelectorAll('[data-workspace-window-id]')).toHaveLength(2);

		await fireEvent.click(
			container.querySelector('[data-workspace-window-fullscreen="window-2"]') as HTMLButtonElement,
		);

		await waitFor(() => expect(layout.snapshot.fullscreenWindowId).toBe('window-2'));
		expect(container.querySelectorAll('[data-workspace-window-id]')).toHaveLength(2);
		expect(container.querySelector('[data-workspace-window-id="window-main"]')).toBe(mainWindow);
		expect(container.querySelector('[data-workspace-window-id="window-2"]')).toBe(gitWindow);
		expect(mainWindow.classList.contains('hidden')).toBe(true);
		expect(mainWindow.getAttribute('aria-hidden')).toBe('true');
		expect(mainWindow.hasAttribute('inert')).toBe(true);
		expect(composerLayer.getAttribute('aria-hidden')).toBe('true');
		expect(composerLayer.hasAttribute('inert')).toBe(true);
		expect(gitWindow.getAttribute('style')).toContain('width: 100%');
		expect(layout.snapshot.desktopRoot).toBe(beforeRoot);
		expect(layout.snapshot.fullscreenWindowId).toBe('window-2');
		expect(container.querySelectorAll('[data-workspace-window-focus-ring]')).toHaveLength(0);
		const gitPanel = container.querySelector(
			'[data-workspace-surface-id="singleton:git"]',
		) as HTMLElement;
		const labelledBy = gitPanel.getAttribute('aria-labelledby');
		expect(labelledBy).toBe('window-2-tab-singleton:git');
		expect(document.getElementById(labelledBy!)).not.toBeNull();

		await fireEvent.click(
			container.querySelector('[data-workspace-window-fullscreen="window-2"]') as HTMLButtonElement,
		);
		await waitFor(() => expect(layout.snapshot.fullscreenWindowId).toBeNull());
		expect(layout.snapshot.desktopRoot).toBe(beforeRoot);
		expect(mainWindow.classList.contains('hidden')).toBe(false);
		expect(mainWindow.getAttribute('aria-hidden')).toBe('false');
		expect(mainWindow.hasAttribute('inert')).toBe(false);
		expect(composerLayer.getAttribute('aria-hidden')).toBe('false');
		expect(composerLayer.hasAttribute('inert')).toBe(false);
		expect(gitWindow.getAttribute('style')).not.toContain('width: 100%');
	});

	it('keeps surviving keyed window identity when another window closes', async () => {
		const { layout } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface-in-new-window',
					surface: portableSingletonDescriptor('git'),
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-2',
					partitionId: 'partition-1',
				},
			]),
		);
		const { container } = renderRoot();
		const mainWindow = container.querySelector('[data-workspace-window-id="window-main"]');

		await fireEvent.click(
			container.querySelector('[data-workspace-window-close="window-2"]') as HTMLButtonElement,
		);

		await waitFor(() =>
			expect(container.querySelectorAll('[data-workspace-window-id]')).toHaveLength(1),
		);
		expect(container.querySelector('[data-workspace-window-id="window-main"]')).toBe(mainWindow);
	});

	it('uses the root window drop layer for a chat regardless of active surface kind', async () => {
		const { layout, windowDnd, workspace } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface',
					surface: portableSingletonDescriptor('git'),
					windowId: 'window-main',
				},
				{
					type: 'activate-window-tab',
					windowId: 'window-main',
					surfaceId: 'singleton:git',
				},
			]),
		);
		const { container } = renderRoot();
		windowDnd.beginChatDrag('chat-b');
		await tick();
		const target = container.querySelector(
			'[data-workspace-window-id="window-main"]',
		) as HTMLElement;
		vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));

		await fireEvent(target, positionedDragEvent('dragover', 95, 50));
		await fireEvent(target, positionedDragEvent('drop', 95, 50));

		await waitFor(() =>
			expect(workspace.openChatInNewWindow).toHaveBeenCalledWith('chat-b', 'window-main', 'right'),
		);
	});
});
