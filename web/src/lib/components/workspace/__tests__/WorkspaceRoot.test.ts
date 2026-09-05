import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
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
import type { ChatSurfaceTransferPort } from '$lib/workspace/chat-surface-transfer.js';
import type {
	ConversationPanelPresentationPort,
	ConversationPanelRegistry,
} from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
import type { ChatMessagesRequest } from '$lib/api/chats.js';
import * as m from '$lib/paraglide/messages.js';
import { resolveUnmeasuredWorkspaceSplit } from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';

const testContext = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const chatApiMocks = vi.hoisted(() => ({ getChatMessages: vi.fn() }));

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
	getWorkspaceHostGeometry: () => testContext.current?.hostGeometry,
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
		getChatMessages: chatApiMocks.getChatMessages,
	};
});

const WorkspaceRoot = (await import('../WorkspaceRoot.svelte')).default;

function chat(
	id: string,
	title: string,
	overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord {
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
		status: 'running',
		agentOwnershipEpoch: null,
		tags: [],
		...overrides,
	};
}

function emptyChatHistory(request: ChatMessagesRequest) {
	return {
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
		partitionRatioBounds: { min: number; max: number; adjustable: boolean };
	} = {
		currentWindowId: 'window-main' as WorkspaceWindowId,
		focusOwner: { kind: 'surface' as const, surfaceId: chatViewSurfaceId('window-main') },
		composerAnchorSurfaceId: chatViewSurfaceId('window-main'),
		partitionRatioBounds: { min: 0.15, max: 0.85, adjustable: true },
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
	let chatSurfaceTransferPort: ChatSurfaceTransferPort | null = null;
	const activateWindowFromCompactNavigation = vi.fn((windowId: WorkspaceWindowId) => {
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
		registerChatSurfaceTransferPort: vi.fn((port: ChatSurfaceTransferPort) => {
			chatSurfaceTransferPort = port;
			return () => {
				if (chatSurfaceTransferPort === port) chatSurfaceTransferPort = null;
			};
		}),
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
		activateWindow: vi.fn(),
		activateWindowFromCompactNavigation,
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
		resolvePartitionRatioBounds: () => runtime.partitionRatioBounds,
		resolveSplitAdmission: (
			targetWindowId: WorkspaceWindowId,
			edge: WorkspaceWindowEdge,
			movingSurfaceId?: string,
		) =>
			resolveUnmeasuredWorkspaceSplit(layout.snapshot, {
				targetWindowId,
				edge,
				movingSurfaceId,
			}),
		moveTabToWindow: vi.fn(
			async (surfaceId: string, destinationWindowId: WorkspaceWindowId, index?: number) => {
				const surface = layout.snapshot.surfaces[surfaceId];
				const sourceWindowId = windowIdOfSurface(layout.snapshot.desktopRoot, surfaceId);
				if (
					surface?.type === 'chat' &&
					surface.chatId &&
					sourceWindowId &&
					sourceWindowId !== destinationWindowId
				) {
					const destinationSurfaceId = chatViewSurfaceId(destinationWindowId);
					const publication = chatSurfaceTransferPort?.prepareChatSurfaceTransfer({
						sourceSurfaceId: surface.id,
						destinationSurfaceId,
						chatId: surface.chatId,
					});
					publication?.publish();
					try {
						commit([
							{
								type: 'move-chat-to-window',
								sourceWindowId,
								destinationWindowId,
								index,
							},
						]);
					} catch (error) {
						publication?.rollback();
						throw error;
					}
					return;
				}
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
	const hostGeometry = {
		size: null,
		compactActive: false,
		singleWindowProjectionActive: false,
		compactSession: 0,
		attach: () => undefined,
	};
	const windowDnd = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
	testContext.current = {
		hostGeometry,
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
	return { layout, runtime, workspace, windowDnd, terminals, localSettings, hostGeometry };
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

function renderRoot(
	isMobile = false,
	props: {
		chatListConsumesWorkspaceWidth?: boolean;
		canEnableChatListAutohide?: boolean;
		onEnableChatListAutohide?: () => void;
	} = {},
) {
	return render(WorkspaceRoot, { isMobile, chatActions, ...props });
}

function positionedDragEvent(type: string, clientX: number, clientY: number): DragEvent {
	const event = new DragEvent(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: clientX },
		clientY: { value: clientY },
	});
	return event;
}

function panelPresentation(
	target: ReturnType<ConversationPanelPresentationPort['captureRestoreTarget']>,
): ConversationPanelPresentationPort {
	return {
		getScrollContainer: () => null,
		getViewport: () => null,
		getQueueContainer: () => undefined,
		captureRestoreTarget: () => target,
		closeTransients: () => {},
	};
}

describe('WorkspaceRoot', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatApiMocks.getChatMessages.mockReset();
		chatApiMocks.getChatMessages.mockImplementation(async (request: ChatMessagesRequest) =>
			emptyChatHistory(request),
		);
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

		expect(container.querySelectorAll('[data-workspace-window-titlebar]')).toHaveLength(2);
		expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(2);
		expect(screen.getByRole('tab', { name: 'Chat A' }).getAttribute('draggable')).toBe('true');
		expect(container.querySelectorAll('[data-workspace-window-close]')).toHaveLength(2);
		const panel = container.querySelector(
			'[data-workspace-surface-id="chat-view:window-main"]',
		) as HTMLElement;
		expect(panel.tabIndex).toBe(-1);
		expect(panel.getAttribute('aria-labelledby')).toBe('window-main-tab-chat-view:window-main');
		expect(document.getElementById('window-main-tab-chat-view:window-main')).not.toBeNull();
		expect(container.querySelector('[data-workspace-window-focus-ring]')).toBeNull();
	});

	it('reserves content gutters only beside vertical separators', () => {
		const { layout } = installContext();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{
					type: 'register-surface-in-new-window',
					surface: portableSingletonDescriptor('git'),
					targetWindowId: 'window-files',
					edge: 'right',
					newWindowId: 'window-edge',
					partitionId: 'partition-edge',
				},
				{ type: 'set-partition-ratio', partitionId: 'partition-main', ratio: 0.3 },
				{ type: 'set-partition-ratio', partitionId: 'partition-edge', ratio: 0.5 },
			]),
		);
		const { container } = renderRoot();
		const contentFor = (windowId: string) =>
			container.querySelector<HTMLElement>(`[data-workspace-window-content="${windowId}"]`)!;

		const chatContent = contentFor('window-main');
		const filesContent = contentFor('window-files');
		const edgeContent = contentFor('window-edge');
		const composerBody = container.querySelector<HTMLElement>('[data-workspace-live-chat-body]')!;

		expect(chatContent.classList.contains('ml-3')).toBe(false);
		expect(chatContent.classList.contains('mr-3')).toBe(true);
		expect(composerBody.classList.contains('ml-3')).toBe(false);
		expect(composerBody.classList.contains('mr-3')).toBe(true);
		expect(filesContent.classList.contains('ml-3')).toBe(true);
		expect(filesContent.classList.contains('mr-3')).toBe(true);
		expect(edgeContent.classList.contains('ml-3')).toBe(true);
		expect(edgeContent.classList.contains('mr-3')).toBe(false);
	});

	it('renders a draft conversation panel without requesting a server transcript', async () => {
		installContext();
		const sessions = testContext.current?.sessions as {
			selectedChat: ChatSessionRecord | null;
			byId: Record<string, ChatSessionRecord>;
		};
		const draft = chat('chat-a', 'Chat A', {
			status: 'draft',
			orderGroup: null,
			effectiveProjectKey: null,
			projectIdentityState: 'pending',
		});
		sessions.selectedChat = draft;
		sessions.byId['chat-a'] = draft;
		chatApiMocks.getChatMessages.mockRejectedValue(new Error('Session not found'));

		renderRoot();
		await tick();

		expect(screen.getByTestId('conversation-panel').dataset.chatId).toBe('chat-a');
		expect(chatApiMocks.getChatMessages).not.toHaveBeenCalled();
	});

	it('adds Chat actions to the tab context menu', async () => {
		installContext();
		renderRoot();

		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Chat A' }));

		const share = await screen.findByRole('menuitem', { name: m.share_button() });
		expect(share.getAttribute('data-slot')).toBe('context-menu-item');
		expect(screen.getByRole('menuitem', { name: m.sidebar_chats_details() })).toBeTruthy();
		expect(
			screen.getByRole('menuitem', { name: m.sidebar_tooltips_edit_chat_name() }),
		).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: m.sidebar_tooltips_delete_chat() })).toBeTruthy();
	});

	it('adds terminal actions to both tab menus', async () => {
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
		const { container } = renderRoot();
		expect(screen.getByRole('tab', { name: 'Dev server' })).toBeTruthy();
		const mainWindow = container.querySelector(
			'[data-workspace-window-id="window-main"]',
		) as HTMLElement;

		await fireEvent.click(
			within(mainWindow).getByRole('button', { name: m.workspace_window_actions() }),
		);

		expect(screen.getByRole('menuitem', { name: m.terminal_rename() })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: m.terminal_paste() })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: /Font size 13px/ })).toBeTruthy();
		await fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByRole('menuitem', { name: m.terminal_rename() })).toBeNull(),
		);

		await fireEvent.contextMenu(screen.getByRole('tab', { name: 'Dev server' }));
		const rename = await screen.findByRole('menuitem', { name: m.terminal_rename() });
		expect(rename.getAttribute('data-slot')).toBe('context-menu-item');
		expect(screen.getByRole('menuitem', { name: m.terminal_paste() })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: /Font size 13px/ }).getAttribute('data-slot')).toBe(
			'context-menu-sub-trigger',
		);
		await fireEvent.click(rename);
		const renameInput = await screen.findByRole('textbox', { name: m.terminal_name() });
		expect((renameInput as HTMLInputElement).value).toBe('Dev server');
		await fireEvent.input(renameInput, { target: { value: 'Build logs' } });
		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_save() }));
		await waitFor(() => expect(terminals.rename).toHaveBeenCalledWith(terminalId, 'Build logs'));

		await fireEvent.click(
			within(mainWindow).getByRole('button', { name: m.workspace_window_actions() }),
		);
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
		expect(collectWindowNodes(layout.snapshot.desktopRoot)).toHaveLength(3);
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
		expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(2);
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
		const liveChatBody = container.querySelector<HTMLElement>('[data-workspace-live-chat-body]')!;
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
		expect(liveChatBody.style.top).toBe('40px');
		expect(liveChatBody.dataset.workspaceLiveChatBodyTopPx).toBe('40');
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
		expect(liveChatBody.style.top).toBe('40px');
		expect(container.querySelectorAll('[data-workspace-window-titlebar]')).toHaveLength(3);
	});

	it('restores a rekeyed Chat panel at its transferred row target', async () => {
		const { layout, workspace } = installContext();
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
		const panels = testContext.current?.conversationPanels as ConversationPanelRegistry;
		const source = panels.panel(chatViewSurfaceId('window-main'));
		if (!source) throw new Error('Expected source panel');
		await waitFor(() => expect(source.transcript.transcriptViewId).toBe('view-chat-a'));
		const target = {
			kind: 'row' as const,
			transcriptViewId: 'view-chat-a',
			ordinal: 1,
			viewportOffset: -23,
		};
		source.attachPresentation(panelPresentation(target));

		await workspace.moveTabToWindow(chatViewSurfaceId('window-main'), 'window-2');

		await waitFor(() => expect(screen.getAllByTestId('conversation-panel')).toHaveLength(1));
		const destination = panels.panel(chatViewSurfaceId('window-2'));
		if (!destination) throw new Error('Expected destination panel');
		destination.attachPresentation(panelPresentation({ kind: 'end' }));
		await waitFor(() => expect(destination.scroll.isPinnedToBottom).toBe(false));
		expect(container.querySelectorAll('[data-workspace-window-id]')).toHaveLength(2);
		expect(screen.getByTestId('conversation-panel').dataset.chatId).toBe('chat-a');
		expect(screen.getByTestId('conversation-panel').dataset.transcriptViewId).toBe('view-chat-a');
		expect(screen.getByTestId('conversation-panel').dataset.panelPinned).toBe('false');
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
		const { runtime, workspace } = installContext();
		const { container } = renderRoot();
		const filesWindow = container.querySelector<HTMLElement>(
			'[data-workspace-window-id="window-files"]',
		)!;
		const filesContent = filesWindow.querySelector<HTMLElement>('[data-workspace-window-content]')!;
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
		const { runtime, workspace } = installContext();
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
		const { workspace } = installContext();
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

	it('replaces the active mobile Chat panel with a transient singleton', async () => {
		const { layout } = installContext();
		const { container } = renderRoot(true);
		const history = portableSingletonDescriptor('git-history');

		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [{ type: 'register-surface', surface: history }]),
		);
		await tick();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{ type: 'set-mobile-presentation', activeId: history.id, returnStack: [] },
			]),
		);
		await tick();

		expect(screen.queryByTestId('conversation-panel')).toBeNull();
		expect(
			container.querySelector(
				`[role="tabpanel"][data-workspace-surface-id="${history.id}"][aria-hidden="false"]`,
			),
		).not.toBeNull();
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
		expect(container.querySelectorAll('[data-workspace-window-id]')).toHaveLength(3);

		await fireEvent.click(
			container.querySelector('[data-workspace-window-fullscreen="window-2"]') as HTMLButtonElement,
		);

		await waitFor(() => expect(layout.snapshot.fullscreenWindowId).toBe('window-2'));
		expect(container.querySelectorAll('[data-workspace-window-id]')).toHaveLength(3);
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

	it('projects compact layouts without remounting keyed windows or portable renderers', async () => {
		const { layout, hostGeometry, workspace } = installContext();
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
		hostGeometry.compactActive = true;
		hostGeometry.singleWindowProjectionActive = true;
		hostGeometry.compactSession = 1;
		const beforeRoot = layout.snapshot.desktopRoot;
		const { container } = renderRoot();
		const host = container.querySelector<HTMLElement>('.workspace-host-region')!;
		const mainWindow = container.querySelector<HTMLElement>(
			'[data-workspace-window-id="window-main"]',
		)!;
		const gitWindow = container.querySelector<HTMLElement>(
			'[data-workspace-window-id="window-2"]',
		)!;
		const gitRenderer = gitWindow.querySelector<HTMLElement>(
			'[data-testid="surface-renderer-stub"]',
		)!;
		const liveChatBody = container.querySelector<HTMLElement>('[data-workspace-live-chat-body]')!;

		expect(host.dataset.workspaceCompact).toBe('true');
		expect(host.dataset.workspaceSingleWindowProjection).toBe('true');
		expect(mainWindow.classList.contains('hidden')).toBe(false);
		expect(mainWindow.getAttribute('style')).toContain('width: 100%');
		expect(gitWindow.classList.contains('hidden')).toBe(true);
		expect(gitRenderer).toBeTruthy();
		expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);
		expect(
			container.querySelector<HTMLElement>('[data-workspace-compact-switcher]')?.style.height,
		).toBe('36px');
		expect(liveChatBody.style.top).toBe('76px');
		expect(liveChatBody.dataset.workspaceLiveChatBodyTopPx).toBe('76');

		const nextButton = screen.getByRole('button', {
			name: m.workspace_compact_next_window(),
		});
		nextButton.focus();
		await fireEvent.click(nextButton);
		await waitFor(() =>
			expect(workspace.activateWindowFromCompactNavigation).toHaveBeenCalledWith('window-2'),
		);
		await waitFor(() => expect(gitWindow.classList.contains('hidden')).toBe(false));
		const remountedNextButton = screen.getByRole('button', {
			name: m.workspace_compact_next_window(),
		});
		await waitFor(() => expect(document.activeElement).toBe(remountedNextButton));

		expect(container.querySelector('[data-workspace-window-id="window-main"]')).toBe(mainWindow);
		expect(container.querySelector('[data-workspace-window-id="window-2"]')).toBe(gitWindow);
		expect(gitWindow.querySelector('[data-testid="surface-renderer-stub"]')).toBe(gitRenderer);
		expect(remountedNextButton).not.toBe(nextButton);
		expect(gitWindow.getAttribute('style')).toContain('width: 100%');
		expect(mainWindow.classList.contains('hidden')).toBe(true);
		expect(layout.snapshot.desktopRoot).toStrictEqual(beforeRoot);

		const listTrigger = screen.getByRole('button', {
			name: m.workspace_compact_window_position({ current: 2, count: 3 }),
		});
		listTrigger.focus();
		await fireEvent.click(listTrigger);
		await fireEvent.click(
			document.querySelector('[data-workspace-compact-window-id="window-main"]') as HTMLElement,
		);
		await waitFor(() => expect(mainWindow.classList.contains('hidden')).toBe(false));
		const remountedListTrigger = screen.getByRole('button', {
			name: m.workspace_compact_window_position({ current: 1, count: 3 }),
		});
		await waitFor(() => expect(document.activeElement).toBe(remountedListTrigger));
		expect(remountedListTrigger).not.toBe(listTrigger);
	});

	it('uses a silent single-window safety projection while tiled geometry is pending', () => {
		const { layout, hostGeometry } = installContext();
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
		hostGeometry.singleWindowProjectionActive = true;
		const { container } = renderRoot();
		const host = container.querySelector<HTMLElement>('.workspace-host-region')!;
		const mainWindow = container.querySelector<HTMLElement>(
			'[data-workspace-window-id="window-main"]',
		)!;

		expect(host.dataset.workspaceCompact).toBeUndefined();
		expect(host.dataset.workspaceSingleWindowProjection).toBe('true');
		expect(mainWindow.getAttribute('style')).toContain('width: 100%');
		expect(
			container
				.querySelector('[data-workspace-window-id="window-2"]')
				?.classList.contains('hidden'),
		).toBe(true);
		expect(container.querySelector('[data-workspace-compact-switcher]')).toBeNull();
		expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);
	});

	it('passes committed dynamic bounds to partition resizers', async () => {
		const { layout, runtime } = installContext();
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
		runtime.partitionRatioBounds = { min: 0.3, max: 0.7, adjustable: true };
		renderRoot();
		const separator = screen
			.getAllByRole('separator', { name: m.layout_resize_windows() })
			.find((candidate) => candidate.getAttribute('aria-valuenow') === '50');
		if (!separator) throw new Error('Expected nested partition separator');

		expect(separator.getAttribute('aria-valuemin')).toBe('30');
		expect(separator.getAttribute('aria-valuemax')).toBe('70');
		expect(separator.getAttribute('aria-disabled')).toBe('false');

		runtime.partitionRatioBounds = { min: 0.5, max: 0.5, adjustable: false };
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{ type: 'set-partition-ratio', partitionId: 'partition-1', ratio: 0.51 },
			]),
		);
		await tick();
		expect(separator.getAttribute('aria-disabled')).toBe('true');
		expect(separator.getAttribute('tabindex')).toBe('-1');
	});

	it('scopes compact recovery-hint dismissal to the measured compact session', async () => {
		const { layout, hostGeometry } = installContext();
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
		hostGeometry.compactActive = true;
		hostGeometry.singleWindowProjectionActive = true;
		hostGeometry.compactSession = 1;
		const onEnableChatListAutohide = vi.fn();
		const view = renderRoot(false, {
			chatListConsumesWorkspaceWidth: true,
			canEnableChatListAutohide: true,
			onEnableChatListAutohide,
		});

		await fireEvent.click(
			screen.getByRole('button', { name: m.workspace_compact_enable_autohide() }),
		);
		expect(onEnableChatListAutohide).toHaveBeenCalledOnce();
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_compact_dismiss_hint() }));
		expect(screen.queryByRole('button', { name: m.workspace_compact_dismiss_hint() })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: m.workspace_compact_next_window() }));
		expect(screen.queryByRole('button', { name: m.workspace_compact_dismiss_hint() })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_fullscreen() }));
		await waitFor(() =>
			expect(
				screen.queryByRole('navigation', { name: m.workspace_compact_window_list() }),
			).toBeNull(),
		);
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_exit_fullscreen() }));
		await waitFor(() =>
			expect(
				screen.getByRole('navigation', { name: m.workspace_compact_window_list() }),
			).toBeTruthy(),
		);
		expect(screen.queryByRole('button', { name: m.workspace_compact_dismiss_hint() })).toBeNull();

		hostGeometry.compactSession = 2;
		await view.rerender({
			isMobile: false,
			chatActions,
			chatListConsumesWorkspaceWidth: false,
			canEnableChatListAutohide: true,
			onEnableChatListAutohide,
		});
		await view.rerender({
			isMobile: false,
			chatActions,
			chatListConsumesWorkspaceWidth: true,
			canEnableChatListAutohide: true,
			onEnableChatListAutohide,
		});
		expect(screen.getByRole('button', { name: m.workspace_compact_dismiss_hint() })).toBeTruthy();
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
			expect(container.querySelectorAll('[data-workspace-window-id]')).toHaveLength(2),
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
