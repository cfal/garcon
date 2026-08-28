import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte';
import { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
import {
	WorkspaceLayoutStore,
	reduceWorkspaceLayout,
} from '$lib/workspace/workspace-layout.svelte';
import { canonicalWorkspaceSnapshot } from '$lib/workspace/canonical-layout';
import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
import { SurfaceFrameRegistry } from '$lib/workspace/surface-frame-registry.svelte';
import {
	CHAT_SURFACE_ID,
	portableSingletonDescriptor,
	isPortableSingleton,
	type PaneId,
	type PortableSingletonKind,
	type SurfaceDescriptor,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from '$lib/workspace/surface-types.js';
import { paneIdOfSurface, paneNodeById, collectPaneNodes } from '$lib/workspace/pane-tree.js';
import { SplitLayoutStore } from '$lib/chat/split/split-layout.svelte.js';
import { surfaceRendererTestProbe } from './surface-renderer-test-probe.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import * as m from '$lib/paraglide/messages.js';

const testContext = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('$lib/context', () => ({
	getChatSessions: () => testContext.current?.sessions,
	getFileSessions: () => testContext.current?.fileSessions,
	getGhCapability: () => testContext.current?.ghCapability,
	getGitBranchActions: () => testContext.current?.gitBranchActions,
	getGitQuickSummary: () => testContext.current?.gitQuickSummary,
	getGitReviewDisplay: () => testContext.current?.gitReviewDisplay,
	getGitViewLauncher: () => testContext.current?.gitViewLauncher,
	getLocalSettings: () => testContext.current?.localSettings,
	getModelCatalog: () => testContext.current?.modelCatalog,
	getNotifications: () => testContext.current?.notifications,
	getOptionalTransientLayers: () => testContext.current?.transientLayers ?? null,
	getRemoteSettings: () => testContext.current?.remoteSettings,
	getSingletonSurfaces: () => testContext.current?.singletonSurfaces,
	getSplitLayout: () => testContext.current?.splitLayout,
	getSurfaceFrames: () => testContext.current?.surfaceFrames,
	getTerminalRegistry: () => testContext.current?.terminals,
	getTransientLayers: () => testContext.current?.transientLayers,
	getWorkspaceContext: () => testContext.current?.workspaceContext,
	getWorkspaceCoordinator: () => testContext.current?.workspace,
	getWorkspacePanesContext: () => testContext.current?.panesContext,
	setWorkspacePanesContext: (value: unknown) => {
		if (testContext.current) testContext.current.panesContext = value;
		return value;
	},
}));

vi.mock('$lib/components/chat/ChatSurface.svelte', async () => ({
	default: (await import('./ChatSurfaceTestStub.svelte')).default,
}));

vi.mock('$lib/components/terminal/TerminalSurface.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));
vi.mock('$lib/components/terminal/TerminalLauncherSurface.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));
vi.mock('$lib/components/files/FileSurface.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));
vi.mock('$lib/components/files/FilesPanel.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));
vi.mock('$lib/components/git/GitWorkbenchPanel.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));
vi.mock('$lib/components/git/GitHistoryPanel.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));
vi.mock('$lib/components/git/GitComparePanel.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));
vi.mock('$lib/components/pr/PullRequestsPanel.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));
vi.mock('$lib/components/git/CommitSurface.svelte', async () => ({
	default: (await import('./SurfaceRendererTestStub.svelte')).default,
}));

const PortableSurfaceContent = (await import('../PortableSurfaceContent.svelte')).default;
const WorkspaceRoot = (await import('../WorkspaceRoot.svelte')).default;

function createSingletonSurfaces(): SingletonSurfaceRegistry {
	const gitSurfaceDeps = createGitSurfaceTestDeps();
	return new SingletonSurfaceRegistry({
		...gitSurfaceDeps,
		createCommit: () => new CommitController(gitSurfaceDeps),
		createPullRequests: () => new PullRequestsStore(),
	});
}

function singletonController(
	registry: SingletonSurfaceRegistry,
	kind: Exclude<Extract<SurfaceDescriptor, { type: 'singleton' }>['kind'], 'chat'>,
): unknown {
	switch (kind) {
		case 'git':
			return registry.gitWorkbench();
		case 'git-history':
			return registry.gitHistory();
		case 'git-compare':
			return registry.gitCompare();
		case 'files':
			return registry.files();
		case 'pull-requests':
			return registry.pullRequests();
		case 'commit':
			return registry.commit();
	}
}

// Two panes: pane-main holds chat+git+pull-requests+terminal, pane-2 holds
// files+commit+file session.
function withAdditionalSurfaces(): WorkspaceLayoutSnapshot {
	const base = canonicalWorkspaceSnapshot();
	return reduceWorkspaceLayout(base, [
		{
			type: 'register-surface',
			surface: { id: 'terminal:one', type: 'terminal', terminalId: 'one' },
			paneId: 'pane-main',
		},
		{
			type: 'register-surface-in-split',
			surface: portableSingletonDescriptor('files'),
			targetPaneId: 'pane-main',
			edge: 'right',
			newPaneId: 'pane-2',
			splitId: 'split-1',
		},
		{
			type: 'register-surface',
			surface: portableSingletonDescriptor('commit'),
			paneId: 'pane-2',
		},
		{
			type: 'register-surface',
			surface: { id: 'file:one', type: 'file', fileSessionId: 'one' },
			paneId: 'pane-2',
		},
		{ type: 'activate-pane-tab', paneId: 'pane-2', surfaceId: 'singleton:files' },
	]);
}

function minimalGitSnapshot(): WorkspaceLayoutSnapshot {
	return {
		desktopRoot: {
			type: 'pane',
			id: 'pane-main',
			tabs: {
				order: [CHAT_SURFACE_ID, 'singleton:git'],
				activeId: 'singleton:git',
				mru: ['singleton:git', CHAT_SURFACE_ID],
			},
		},
		surfaces: {
			[CHAT_SURFACE_ID]: { id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' },
			'singleton:git': { id: 'singleton:git', type: 'singleton', kind: 'git' },
		},
		fullscreenPaneId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: 'singleton:git',
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
	};
}

function mobileFileSnapshot(): WorkspaceLayoutSnapshot {
	const base = canonicalWorkspaceSnapshot();
	return {
		...base,
		surfaces: {
			...base.surfaces,
			'file:one': { id: 'file:one', type: 'file', fileSessionId: 'one' },
		},
		mobileActiveSurfaceId: 'file:one',
		mobileOnlySurfaceIds: ['file:one'],
	};
}

function mobileCommitSnapshot(): WorkspaceLayoutSnapshot {
	return reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
		{
			type: 'register-surface',
			surface: portableSingletonDescriptor('commit'),
		},
		{
			type: 'set-mobile-presentation',
			activeId: 'singleton:commit',
			returnStack: [],
		},
	]);
}

function selectedChat(): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
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

function createWorkspace(initial: WorkspaceLayoutSnapshot) {
	const layout = new WorkspaceLayoutStore(initial);
	const commit = (mutations: readonly WorkspaceLayoutMutation[]): void => {
		const next = reduceWorkspaceLayout(layout.snapshot, mutations);
		if (!layout.publish(layout.revision, next)) throw new Error('Test layout publication failed');
	};
	const paneOf = (surfaceId: string): PaneId | null =>
		paneIdOfSurface(layout.snapshot.desktopRoot, surfaceId);

	return {
		layout,
		attachmentErrors: {} as Record<string, string>,
		get defaultActiveId() {
			return layout.defaultActiveId;
		},
		get defaultPaneId() {
			return layout.chatPaneId;
		},
		get lastFocusedPaneId() {
			return layout.chatPaneId;
		},
		get paneCount() {
			return collectPaneNodes(layout.snapshot.desktopRoot).length;
		},
		get canSplitPane() {
			return this.paneCount < 4;
		},
		get isChatPresented() {
			const chatPaneId = paneOf(CHAT_SURFACE_ID);
			if (!chatPaneId) return false;
			if (layout.snapshot.fullscreenPaneId && layout.snapshot.fullscreenPaneId !== chatPaneId) {
				return false;
			}
			return (
				paneNodeById(layout.snapshot.desktopRoot, chatPaneId)?.tabs.activeId === CHAT_SURFACE_ID
			);
		},
		get isChatInteractive() {
			return this.isChatPresented;
		},
		noteSurfaceFocus: vi.fn(),
		notePaneChromeFocus: vi.fn(),
		frameVersion: vi.fn(() => 0),
		isSurfaceCloseBlocked: vi.fn(() => false),
		retryPresentation: vi.fn(async () => undefined),
		setSplitRatio: vi.fn(async () => undefined),
		toggleFullscreen: vi.fn(async (paneId: PaneId) =>
			commit([
				{
					type: 'set-fullscreen-pane',
					paneId: layout.snapshot.fullscreenPaneId === paneId ? null : paneId,
				},
			]),
		),
		focusSurface: vi.fn(async (surfaceId: string) => {
			const paneId = paneOf(surfaceId);
			if (paneId) commit([{ type: 'activate-pane-tab', paneId, surfaceId }]);
		}),
		moveTabToPane: vi.fn(async (surfaceId: string, destinationPaneId: PaneId) => {
			commit([{ type: 'move-tab', surfaceId, destinationPaneId }]);
		}),
		splitTabToEdge: vi.fn(async () => undefined),
		mergePaneInto: vi.fn(async () => undefined),
		openSingletonAsTab: vi.fn(async (kind: PortableSingletonKind, paneId: PaneId) => {
			const surfaceId = `singleton:${kind}`;
			const mutations: WorkspaceLayoutMutation[] = [];
			if (!layout.snapshot.surfaces[surfaceId]) {
				mutations.push({
					type: 'register-surface',
					surface: portableSingletonDescriptor(kind),
					paneId,
				});
			} else if (paneOf(surfaceId) !== paneId) {
				mutations.push({ type: 'move-tab', surfaceId, destinationPaneId: paneId });
			}
			mutations.push({ type: 'activate-pane-tab', paneId, surfaceId });
			commit(mutations);
		}),
		closeSurface: vi.fn(async (surfaceId: string) => {
			commit([{ type: 'remove-surface', surfaceId }]);
			return true;
		}),
		popOutFile: vi.fn(async () => true),
		focusMobileSingleton: vi.fn(async () => undefined),
		createTerminal: vi.fn(async () => undefined),
		openTerminalSession: vi.fn(async () => undefined),
		mobileBack: vi.fn(async () => undefined),
	};
}

function installContext(initial: WorkspaceLayoutSnapshot = withAdditionalSurfaces()) {
	const singletonSurfaces = createSingletonSurfaces();
	const workspace = createWorkspace(initial);
	const fileSession = { fileName: 'one.ts', dirty: false };
	const surfaceFrames = new SurfaceFrameRegistry();
	testContext.current = {
		workspace,
		workspaceContext: {
			projectState: { kind: 'absent' },
			currentProject: null,
			canUpdateProjectPath: false,
		},
		singletonSurfaces,
		fileSessions: {
			get: (fileSessionId: string) => (fileSessionId === 'one' ? fileSession : null),
			showOpenFiles: vi.fn(),
		},
		terminals: {
			sessions: {
				one: { metadata: { terminalId: 'one', displaySequence: 1 } },
			},
			orderedSessions: [{ metadata: { terminalId: 'one', displaySequence: 1 } }],
			listStatus: 'ready',
		},
		transientLayers: {
			register: vi.fn(() => vi.fn()),
			open: vi.fn((_modality: string, action: () => void) => action()),
			handleEscape: vi.fn(() => false),
		},
		sessions: { selectedChat: null },
		modelCatalog: { supportsFork: () => false, supportsForkWhileRunning: () => false },
		splitLayout: { isEnabled: false },
		gitQuickSummary: {
			setEnabled: vi.fn(),
			setProcessing: vi.fn(),
			setProject: vi.fn(),
			summaryFor: vi.fn(() => null),
			startPolling: vi.fn(() => vi.fn()),
			scheduleRefresh: vi.fn(),
		},
		gitReviewDisplay: createGitSurfaceTestDeps().reviewDisplay,
		gitViewLauncher: {
			openHistory: vi.fn(),
			openCompare: vi.fn(),
		},
		remoteSettings: {
			snapshot: null,
			ensureLoadedInBackground: vi.fn(async () => undefined),
		},
		gitBranchActions: {
			showNewBranchModal: false,
			closeNewBranchDialog: vi.fn(),
			setProject: vi.fn(),
		},
		ghCapability: { hasChecked: true, available: true, refresh: vi.fn() },
		localSettings: { showQuickCommitTray: false },
		surfaceFrames,
		notifications: { error: vi.fn() },
	};
	return { singletonSurfaces, workspace, surfaceFrames };
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

const portableSurfaces: Array<{ name: string; descriptor: SurfaceDescriptor }> = [
	{ name: 'terminal', descriptor: { id: 'terminal:one', type: 'terminal', terminalId: 'one' } },
	{ name: 'terminal launcher', descriptor: { id: 'terminal-launcher', type: 'terminal-launcher' } },
	{ name: 'file', descriptor: { id: 'file:one', type: 'file', fileSessionId: 'one' } },
	{ name: 'Files', descriptor: { id: 'singleton:files', type: 'singleton', kind: 'files' } },
	{ name: 'Git', descriptor: { id: 'singleton:git', type: 'singleton', kind: 'git' } },
	{
		name: 'History',
		descriptor: {
			id: 'singleton:git-history',
			type: 'singleton',
			kind: 'git-history',
		},
	},
	{
		name: 'Compare',
		descriptor: {
			id: 'singleton:git-compare',
			type: 'singleton',
			kind: 'git-compare',
		},
	},
	{
		name: 'pull requests',
		descriptor: {
			id: 'singleton:pull-requests',
			type: 'singleton',
			kind: 'pull-requests',
		},
	},
	{ name: 'Commit', descriptor: { id: 'singleton:commit', type: 'singleton', kind: 'commit' } },
];

beforeEach(() => {
	surfaceRendererTestProbe.reset();
	vi.stubGlobal('ResizeObserver', class {
		observe() {}
		unobserve() {}
		disconnect() {}
	});
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_400);
});

afterEach(() => {
	cleanup();
	(testContext.current?.surfaceFrames as SurfaceFrameRegistry | undefined)?.destroy();
	(testContext.current?.singletonSurfaces as SingletonSurfaceRegistry | undefined)?.destroy();
	testContext.current = null;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('PortableSurfaceContent', () => {
	it.each(portableSurfaces)('remounts $name with retained registries', async ({ descriptor }) => {
		const { singletonSurfaces } = installContext();
		let retainedController: unknown = null;
		if (descriptor.type === 'singleton' && descriptor.kind !== 'chat') {
			retainedController = singletonController(singletonSurfaces, descriptor.kind);
		}
		const props = {
			surface: descriptor,
			presentation: 'pane-main' as PaneId,
			visible: true,
			onSendToChat: vi.fn(async () => true),
			onAppendToChatDraft: vi.fn(() => 'appended' as const),
			frameBridge: new SurfaceFrameBridge(),
		};

		const first = render(PortableSurfaceContent, props);
		await screen.findByTestId('surface-renderer-stub');
		first.unmount();

		expect(() => render(PortableSurfaceContent, props)).not.toThrow();
		await screen.findByTestId('surface-renderer-stub');
		expect(screen.queryByText(/unsafe state mutation/i)).toBeNull();
		if (descriptor.type === 'singleton' && descriptor.kind !== 'chat') {
			expect(singletonController(singletonSurfaces, descriptor.kind)).toBe(retainedController);
		}
	});
});

describe('WorkspaceRoot', () => {
	it('opens a singleton as a tab in another pane through that pane’s Open command', async () => {
		const { workspace } = installContext(withAdditionalSurfaces());
		const { container } = render(WorkspaceRoot, { isMobile: false, chatActions });
		const openGitWorkbench = m.workspace_open_surface({
			surface: m.workspace_surface_git_workbench(),
		});
		const taskbarFor = (paneId: string) =>
			container.querySelector(`[data-workspace-pane-id="${paneId}"]`);
		const paneMain = taskbarFor('pane-main');
		const paneTwo = taskbarFor('pane-2');
		expect(paneMain).toBeTruthy();
		expect(paneTwo).toBeTruthy();
		if (!paneMain || !paneTwo) return;

		// pane-main already hosts Git Workbench, so its menu omits it.
		await fireEvent.click(
			paneMain.querySelector<HTMLButtonElement>(
				'[data-workspace-taskbar-end] [data-slot="dropdown-menu-trigger"]',
			)!,
		);
		expect(screen.queryByRole('menuitem', { name: openGitWorkbench })).toBeNull();
		await fireEvent.keyDown(document, { key: 'Escape' });

		await fireEvent.click(
			paneTwo.querySelector<HTMLButtonElement>(
				'[data-workspace-taskbar-end] [data-slot="dropdown-menu-trigger"]',
			)!,
		);
		await fireEvent.click(screen.getByRole('menuitem', { name: openGitWorkbench }));
		await waitFor(() => {
			expect(
				paneNodeById(workspace.layout.snapshot.desktopRoot, 'pane-main' as PaneId)?.tabs.order,
			).not.toContain('singleton:git');
			expect(
				paneNodeById(workspace.layout.snapshot.desktopRoot, 'pane-2' as PaneId)?.tabs.activeId,
			).toBe('singleton:git');
		});
	});

	it('opens the user-message navigator from the active Chat pane menu', async () => {
		installContext(canonicalWorkspaceSnapshot());
		testContext.current!.workspaceContext = {
			currentProject: '/workspace/project',
			canUpdateProjectPath: true,
		};
		testContext.current!.sessions = { selectedChat: selectedChat() };
		render(WorkspaceRoot, { isMobile: false, chatActions });
		const chatSurface = screen.getByTestId('chat-surface-stub');
		await waitFor(() => expect(chatSurface.dataset.navigatorOpenCount).toBe('0'));

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		await fireEvent.click(
			screen.getByRole('menuitem', { name: m.chat_user_message_navigator_menu() }),
		);

		await waitFor(() => expect(chatSurface.dataset.navigatorOpenCount).toBe('1'));
	});

	it('does not expose the user-message navigator when Chat is not the active pane tab', async () => {
		installContext(minimalGitSnapshot());
		testContext.current!.workspaceContext = {
			currentProject: '/workspace/project',
			canUpdateProjectPath: true,
		};
		testContext.current!.sessions = { selectedChat: selectedChat() };
		render(WorkspaceRoot, { isMobile: false, chatActions });
		await waitFor(() =>
			expect(screen.getByTestId('chat-surface-stub').dataset.navigatorOpenCount).toBe('0'),
		);

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));

		expect(
			screen.queryByRole('menuitem', { name: m.chat_user_message_navigator_menu() }),
		).toBeNull();
	});

	it('places Chat split view immediately before the shared fullscreen command', async () => {
		installContext(canonicalWorkspaceSnapshot());
		testContext.current!.workspaceContext = {
			currentProject: '/workspace/project',
			canUpdateProjectPath: true,
		};
		testContext.current!.sessions = { selectedChat: selectedChat() };
		render(WorkspaceRoot, { isMobile: false, chatActions });

		await fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }));
		const items = screen.getAllByRole('menuitem');
		const split = screen.getByRole('menuitem', { name: m.workspace_split_view() });
		const fullscreen = screen.getByRole('menuitem', { name: m.workspace_fullscreen() });

		expect(items.indexOf(fullscreen)).toBe(items.indexOf(split) + 1);
	});

	it('renders one taskbar per pane with its own tabs', async () => {
		installContext(withAdditionalSurfaces());
		const { container } = render(WorkspaceRoot, {
			isMobile: false,
			chatActions,
		});
		const paneMain = container.querySelector<HTMLElement>('[data-workspace-pane-id="pane-main"]');
		const paneTwo = container.querySelector<HTMLElement>('[data-workspace-pane-id="pane-2"]');

		expect(paneMain?.querySelector('[data-workspace-taskbar-center] [role="tablist"]')).toBeTruthy();
		expect(paneTwo?.querySelector('[data-workspace-taskbar-center] [role="tablist"]')).toBeTruthy();
		expect(
			paneTwo?.querySelector(`[aria-label="${m.workspace_taskbar_actions()}"]`),
		).toBeTruthy();
		expect(document.getElementById('pane-main-tab-singleton:chat')).toBeTruthy();
		expect(document.getElementById('pane-2-tab-singleton:files')).toBeTruthy();
	});

	it('hides non-fullscreen panes without unmounting them', async () => {
		const { workspace } = installContext(withAdditionalSurfaces());
		const { container } = render(WorkspaceRoot, {
			isMobile: false,
			chatActions,
		});
		const paneMain = container.querySelector<HTMLElement>('[data-workspace-pane-id="pane-main"]');
		const paneTwo = container.querySelector<HTMLElement>('[data-workspace-pane-id="pane-2"]');
		expect(paneMain && paneTwo).toBeTruthy();
		if (!paneMain || !paneTwo) return;

		await workspace.toggleFullscreen('pane-2');
		await tick();

		expect(paneMain.classList).toContain('hidden');
		expect(paneMain.hasAttribute('inert')).toBe(true);
		expect(paneTwo.classList).not.toContain('hidden');
		expect(
			container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`),
		).toBeTruthy();

		await workspace.toggleFullscreen('pane-2');
		await tick();
		expect(paneMain.classList).not.toContain('hidden');
		expect(paneMain.hasAttribute('inert')).toBe(false);
	});

	it('keeps Chat mounted, inert, and draft-capable during another pane’s fullscreen', async () => {
		// Git lives in the fullscreened pane so its content stays interactive.
		const initial = reduceWorkspaceLayout(withAdditionalSurfaces(), [
			{ type: 'move-tab', surfaceId: 'singleton:git', destinationPaneId: 'pane-2' },
		]);
		const { workspace } = installContext(initial);
		const { container } = render(WorkspaceRoot, {
			isMobile: false,
			chatActions,
		});
		const paneMain = container.querySelector<HTMLElement>('[data-workspace-pane-id="pane-main"]');
		const chatSurface = screen.getByTestId('chat-surface-stub');
		const chatInput = screen.getByRole('textbox', {
			name: 'Chat focus target',
		}) as HTMLTextAreaElement;
		expect(paneMain).toBeTruthy();
		if (!paneMain) return;

		await fireEvent.input(chatInput, { target: { value: 'Retain this draft' } });
		await workspace.toggleFullscreen('pane-2');
		await tick();

		expect(screen.getByTestId('chat-surface-stub')).toBe(chatSurface);
		expect(chatInput.value).toBe('Retain this draft');
		expect(paneMain.classList).toContain('hidden');
		expect(chatSurface.getAttribute('data-visible')).toBe('false');
		expect(chatSurface.getAttribute('data-interactive')).toBe('false');

		await fireEvent.click(screen.getByRole('button', { name: 'Append review comment' }));
		expect(chatInput.value).toContain('Retain this draft');
		expect(chatInput.value).toContain('Git review comment');

		await workspace.toggleFullscreen('pane-2');
		await tick();
		expect(paneMain.classList).not.toContain('hidden');
		expect(screen.getByTestId('chat-surface-stub')).toBe(chatSurface);
		expect(chatInput.value).toContain('Git review comment');
	});

	it('shows Agents only while the Chat feed is the active tab of its pane', async () => {
		installContext(minimalGitSnapshot());
		testContext.current!.sessions = { selectedChat: selectedChat() };
		const snapshot = reduceWorkspaceLayout(minimalGitSnapshot(), [
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: CHAT_SURFACE_ID },
		]);
		installContext(snapshot);
		const { container } = render(WorkspaceRoot, {
			isMobile: false,
			chatActions,
		});
		const start = container.querySelector('[data-workspace-taskbar-start]');
		const end = container.querySelector('[data-workspace-taskbar-end]');
		const agents = await screen.findByRole('button', { name: /Agents/ });

		expect(start?.contains(agents)).toBe(true);
		expect(end?.contains(agents)).toBe(false);

		await fireEvent.click(screen.getByRole('tab', { name: m.workspace_surface_git() }));
		await waitFor(() => expect(screen.queryByRole('button', { name: /Agents/ })).toBeNull());

		await fireEvent.click(screen.getByRole('tab', { name: m.workspace_surface_chat() }));
		expect(await screen.findByRole('button', { name: /Agents/ })).toBeTruthy();
	});

	it('binds focus, move, and close for every portable kind without replacing Chat', async () => {
		const { workspace } = installContext();
		const { container } = render(WorkspaceRoot, {
			isMobile: false,
			chatActions,
		});
		const chatNode = container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`);
		expect(chatNode).toBeTruthy();

		for (const surfaceId of [
			'singleton:git',
			'singleton:pull-requests',
			'singleton:files',
			'singleton:commit',
			'terminal:one',
			'file:one',
		]) {
			const source = paneIdOfSurface(workspace.layout.snapshot.desktopRoot, surfaceId);
			expect(source).toBeTruthy();
			if (!source) continue;
			const destination: PaneId = source === 'pane-main' ? 'pane-2' : 'pane-main';
			const tab = document.getElementById(`${source}-tab-${surfaceId}`);
			expect(tab).toBeTruthy();
			await fireEvent.click(tab!);
			await waitFor(() =>
				expect(
					paneNodeById(workspace.layout.snapshot.desktopRoot, source)?.tabs.activeId,
				).toBe(surfaceId),
			);
			expect(container.querySelector(`[data-workspace-surface-id="${surfaceId}"]`)).toBeTruthy();

			await workspace.moveTabToPane(surfaceId, destination);
			await tick();
			expect(document.getElementById(`${destination}-panel-${surfaceId}`)).toBeTruthy();
			expect(container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`)).toBe(
				chatNode,
			);

			await workspace.closeSurface(surfaceId);
			await tick();
			expect(container.querySelector(`[data-workspace-surface-id="${surfaceId}"]`)).toBeNull();
			expect(container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`)).toBe(
				chatNode,
			);
		}
	});

	it('offers one destructive Close without non-destructive Back for a mobile file', async () => {
		const { workspace } = installContext(mobileFileSnapshot());
		workspace.closeSurface.mockResolvedValueOnce(true);
		render(WorkspaceRoot, {
			isMobile: true,
			chatActions,
		});

		expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
		const closeButtons = await screen.findAllByRole('button', { name: 'Close file' });
		expect(closeButtons).toHaveLength(1);
		await fireEvent.click(closeButtons[0]);

		expect(workspace.closeSurface).toHaveBeenCalledWith('file:one');
		expect(workspace.mobileBack).not.toHaveBeenCalled();
	});

	it('retains Back and Close view controls for mobile Commit', async () => {
		const { workspace } = installContext(mobileCommitSnapshot());
		workspace.closeSurface.mockResolvedValueOnce(true);
		render(WorkspaceRoot, {
			isMobile: true,
			chatActions,
		});

		await fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
		expect(workspace.mobileBack).toHaveBeenCalledOnce();

		await fireEvent.click(screen.getByRole('button', { name: 'Close view' }));
		expect(workspace.closeSurface).toHaveBeenCalledWith('singleton:commit');
	});

	it('reserves chat content space only while the desktop taskbar is rendered', async () => {
		installContext(canonicalWorkspaceSnapshot());
		const rendered = render(WorkspaceRoot, {
			isMobile: false,
			chatActions,
		});

		expect(rendered.container.querySelector('[data-floating-workspace-toolbar]')).toBeTruthy();
		expect(
			screen.getByTestId('chat-surface-stub').getAttribute('data-reserve-top-floating-toolbar'),
		).toBe('true');

		await rendered.rerender({ isMobile: true, chatActions });

		expect(rendered.container.querySelector('[data-floating-workspace-toolbar]')).toBeNull();
		expect(
			screen.getByTestId('chat-surface-stub').getAttribute('data-reserve-top-floating-toolbar'),
		).toBe('false');
	});

	it('lowers the Chat pane taskbar below split pane headers while split view is active', async () => {
		installContext(canonicalWorkspaceSnapshot());
		const splitLayout = new SplitLayoutStore();
		testContext.current!.splitLayout = splitLayout;
		const { container } = render(WorkspaceRoot, { isMobile: false, chatActions });
		const toolbar = () => container.querySelector<HTMLElement>('[data-floating-workspace-toolbar]');

		expect(toolbar()?.classList.contains('top-2')).toBe(true);
		expect(toolbar()?.classList.contains('top-9')).toBe(false);

		splitLayout.enableWithChat('chat-1');
		await tick();

		expect(toolbar()?.classList.contains('top-9')).toBe(true);
		expect(toolbar()?.classList.contains('top-2')).toBe(false);

		splitLayout.disable();
		await tick();

		expect(toolbar()?.classList.contains('top-2')).toBe(true);
		expect(toolbar()?.classList.contains('top-9')).toBe(false);
	});

	it('keeps a non-Chat pane taskbar raised while chat split view is active', () => {
		installContext(minimalGitSnapshot());
		const splitLayout = new SplitLayoutStore();
		splitLayout.enableWithChat('chat-1');
		testContext.current!.splitLayout = splitLayout;
		const { container } = render(WorkspaceRoot, { isMobile: false, chatActions });
		const toolbar = container.querySelector<HTMLElement>('[data-floating-workspace-toolbar]');

		expect(toolbar?.classList.contains('top-2')).toBe(true);
		expect(toolbar?.classList.contains('top-9')).toBe(false);
	});

	it('hands a retained renderer across desktop and mobile without duplicate attachment', async () => {
		const { workspace, surfaceFrames } = installContext(minimalGitSnapshot());
		const desktopExpectation = surfaceFrames.beginTransfer('singleton:git', 'pane-main');
		const rendered = render(WorkspaceRoot, {
			isMobile: false,
			chatActions,
		});
		const chatNode = rendered.container.querySelector(
			`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`,
		);
		const desktopFrame = await surfaceFrames.waitFor(desktopExpectation);
		await desktopFrame.attachRetainedRenderer();
		await waitFor(() => expect(surfaceRendererTestProbe.attached).toBe(1));

		const mobileExpectation = surfaceFrames.beginTransfer('singleton:git', 'mobile');
		await rendered.rerender({ isMobile: true, chatActions });
		const mobileFrame = await surfaceFrames.waitFor(mobileExpectation);
		await mobileFrame.attachRetainedRenderer();
		await waitFor(() => expect(surfaceRendererTestProbe.attached).toBe(1));
		expect(
		rendered.container.querySelectorAll('[data-workspace-surface-id="singleton:git"]'),
		).toHaveLength(1);
		expect(
			rendered.container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`),
		).toBe(chatNode);

		const returnedDesktopExpectation = surfaceFrames.beginTransfer('singleton:git', 'pane-main');
		await rendered.rerender({ isMobile: false, chatActions });
		const returnedDesktopFrame = await surfaceFrames.waitFor(returnedDesktopExpectation);
		await returnedDesktopFrame.attachRetainedRenderer();
		await waitFor(() => expect(surfaceRendererTestProbe.attached).toBe(1));
		expect(surfaceRendererTestProbe.maximumAttached).toBe(1);
		expect(
			paneNodeById(workspace.layout.snapshot.desktopRoot, 'pane-main' as PaneId)?.tabs.activeId,
		).toBe('singleton:git');
		expect(screen.queryByText(/unsafe state mutation/i)).toBeNull();
	});

	it('contains an attachment failure and delegates retry without replacing Chat', async () => {
		const { workspace } = installContext(minimalGitSnapshot());
		workspace.attachmentErrors['singleton:git'] = 'Test attachment failure';
		const { container } = render(WorkspaceRoot, {
			isMobile: false,
			chatActions,
		});
		const chatNode = container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`);

		expect(await screen.findByText('Test attachment failure')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(workspace.retryPresentation).toHaveBeenCalledWith('singleton:git', 'pane-main');
		expect(container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`)).toBe(
			chatNode,
		);
	});
});
