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
	type PortableSingletonKind,
	type WorkspaceLayoutMutation,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
} from '$lib/workspace/surface-types.js';
import { collectWindowNodes, windowIdOfSurface } from '$lib/workspace/window-tree.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';

const testContext = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('$lib/context', () => ({
	getChatSessions: () => testContext.current?.sessions,
	getFileSessions: () => testContext.current?.fileSessions,
	getGhCapability: () => testContext.current?.ghCapability,
	getGitBranchActions: () => testContext.current?.gitBranchActions,
	getModelCatalog: () => testContext.current?.modelCatalog,
	getNotifications: () => testContext.current?.notifications,
	getSurfaceFrames: () => testContext.current?.surfaceFrames,
	getTerminalRegistry: () => testContext.current?.terminals,
	getWorkspaceCoordinator: () => testContext.current?.workspace,
	getWorkspaceWindowDnd: () => testContext.current?.windowDnd,
	getOptionalTransientLayers: () => null,
}));

vi.mock('$lib/components/chat/ChatSurface.svelte', async () => ({
	default: (await import('./ChatSurfaceTestStub.svelte')).default,
}));
vi.mock('$lib/components/chat/ChatWindowPreview.svelte', async () => ({
	default: (await import('./ChatWindowPreviewStub.svelte')).default,
}));
vi.mock('$lib/components/workspace/PortableSurfaceContent.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));

const WorkspaceRoot = (await import('../WorkspaceRoot.svelte')).default;

function chat(id: string, title: string): ChatSessionRecord {
	return {
		id,
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
	const runtime = { currentWindowId: 'window-main' as WorkspaceWindowId };
	const commit = (mutations: readonly WorkspaceLayoutMutation[]): void => {
		const next = reduceWorkspaceLayout(layout.snapshot, mutations);
		if (!layout.publish(layout.revision, next)) throw new Error('Test publication failed');
	};
	const focusSurface = vi.fn(async (surfaceId: string) => {
		const windowId = windowIdOfSurface(layout.snapshot.desktopRoot, surfaceId);
		if (!windowId) return;
		runtime.currentWindowId = windowId;
		commit([{ type: 'activate-window-tab', windowId, surfaceId }]);
	});
	const workspace = {
		layout,
		attachmentErrors: {} as Record<string, string>,
		get currentWindowId() {
			void layout.revision;
			return runtime.currentWindowId;
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
		noteSurfaceFocus: vi.fn((surfaceId: string) => {
			const windowId = windowIdOfSurface(layout.snapshot.desktopRoot, surfaceId);
			if (windowId) runtime.currentWindowId = windowId;
		}),
		noteWindowChromeFocus: vi.fn((windowId: WorkspaceWindowId) => {
			runtime.currentWindowId = windowId;
		}),
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
		openTerminalSession: vi.fn(async () => undefined),
		retryPresentation: vi.fn(async () => undefined),
		mobileBack: vi.fn(async () => undefined),
		focusChat: vi.fn(async () => undefined),
	};
	const windowDnd = new WorkspaceWindowDndController(layout);
	testContext.current = {
		workspace,
		windowDnd,
		surfaceFrames: new SurfaceFrameRegistry(),
		fileSessions: { get: () => null, showOpenFiles: vi.fn() },
		terminals: { orderedSessions: [], sessions: {}, listStatus: 'ready' },
		sessions: {
			selectedChatId: 'chat-a',
			selectedChat: chat('chat-a', 'Chat A'),
			byId: { 'chat-a': chat('chat-a', 'Chat A'), 'chat-b': chat('chat-b', 'Chat B') },
			isChatProcessing: () => false,
		},
		modelCatalog: {
			supportsFork: () => false,
			supportsForkWhileRunning: () => false,
			supportsUpdateProjectPath: () => false,
		},
		gitBranchActions: { showNewBranchModal: false },
		ghCapability: { hasChecked: true, available: true },
		notifications: { error: vi.fn() },
	};
	return { layout, runtime, workspace, windowDnd };
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
		expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(0);
		expect(screen.getByText('Chat A')).toBeTruthy();
		const panel = container.querySelector(
			'[data-workspace-surface-id="chat-view:window-main"]',
		) as HTMLElement;
		expect(panel.tabIndex).toBe(-1);
		expect(panel.getAttribute('aria-labelledby')).toBe('window-main-tab-chat-view:window-main');
		expect(document.getElementById('window-main-tab-chat-view:window-main')).not.toBeNull();
		expect(container.querySelector('[data-workspace-window-focus-ring]')).toBeNull();
	});

	it('keeps one live Chat surface mounted while its local tab becomes hidden', async () => {
		const { layout, workspace } = installContext();
		const { container } = renderRoot();
		const liveChat = screen.getByTestId('chat-surface-stub');

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
		expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
		await workspace.focusSurface(chatViewSurfaceId('window-main'));
		await tick();
		expect(screen.getByTestId('chat-surface-stub')).toBe(liveChat);
		expect(liveChat.getAttribute('data-visible')).toBe('true');
	});

	it('moves the single live Chat layer between windows and previews the other chat', async () => {
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
		expect(screen.getByTestId('chat-window-preview').dataset.chatId).toBe('chat-b');
		expect(screen.getByTestId('chat-window-preview').dataset.textScale).toBe('0.85');
		expect(liveChat.dataset.textScale).toBe('0.85');
		expect(
			container
				.querySelector('[data-workspace-window-focus-ring]')
				?.classList.contains('ring-workspace-window-focus'),
		).toBe(true);

		await workspace.focusSurface(chatViewSurfaceId('window-2'));
		await tick();

		expect(screen.getByTestId('chat-surface-stub')).toBe(liveChat);
		expect(screen.getByTestId('chat-window-preview').dataset.chatId).toBe('chat-a');
		expect(container.querySelectorAll('[data-workspace-window-titlebar]')).toHaveLength(2);
	});

	it('does not render hidden desktop Chat previews in mobile mode', () => {
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

		expect(screen.queryAllByTestId('chat-window-preview')).toHaveLength(0);
		expect(screen.getByTestId('chat-surface-stub').dataset.visible).toBe('true');
		expect(screen.getByTestId('chat-surface-stub').dataset.textScale).toBe('1');
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
		expect(container.querySelectorAll('[data-workspace-window-id]')).toHaveLength(2);

		await fireEvent.click(
			container.querySelector('[data-workspace-window-fullscreen="window-2"]') as HTMLButtonElement,
		);

		await waitFor(() => expect(layout.snapshot.fullscreenWindowId).toBe('window-2'));
		expect(container.querySelectorAll('[data-workspace-window-id]')).toHaveLength(2);
		expect(container.querySelector('[data-workspace-window-id="window-main"]')).toBe(mainWindow);
		expect(container.querySelector('[data-workspace-window-id="window-2"]')).toBe(gitWindow);
		expect(mainWindow.classList.contains('hidden')).toBe(true);
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
