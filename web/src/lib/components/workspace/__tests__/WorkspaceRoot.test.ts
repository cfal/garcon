import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { PullRequestsStore } from '$lib/stores/pull-requests.svelte';
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
	type HostId,
	type SurfaceDescriptor,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from '$lib/workspace/surface-types.js';
import { surfaceRendererTestProbe } from './surface-renderer-test-probe.js';

const testContext = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('$lib/context', () => ({
	getChatSessions: () => testContext.current?.sessions,
	getFileSessions: () => testContext.current?.fileSessions,
	getGhCapability: () => testContext.current?.ghCapability,
	getGitBranchActions: () => testContext.current?.gitBranchActions,
	getGitQuickSummary: () => testContext.current?.gitQuickSummary,
	getLocalSettings: () => testContext.current?.localSettings,
	getModelCatalog: () => testContext.current?.modelCatalog,
	getNotifications: () => testContext.current?.notifications,
	getOptionalTransientLayers: () => testContext.current?.transientLayers ?? null,
	getSingletonSurfaces: () => testContext.current?.singletonSurfaces,
	getSplitLayout: () => testContext.current?.splitLayout,
	getSurfaceFrames: () => testContext.current?.surfaceFrames,
	getTerminalRegistry: () => testContext.current?.terminals,
	getTransientLayers: () => testContext.current?.transientLayers,
	getWorkspaceContext: () => testContext.current?.workspaceContext,
	getWorkspaceCoordinator: () => testContext.current?.workspace,
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
vi.mock('$lib/components/git/GitPanel.svelte', async () => ({
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

class TestResizeObserver implements ResizeObserver {
	static instances: TestResizeObserver[] = [];
	readonly callback: ResizeObserverCallback;
	readonly observed = new Set<Element>();

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		TestResizeObserver.instances.push(this);
	}

	disconnect(): void {
		this.observed.clear();
	}

	observe(target: Element): void {
		this.observed.add(target);
	}

	unobserve(target: Element): void {
		this.observed.delete(target);
	}

	emit(target: Element, width: number): void {
		if (!this.observed.has(target)) return;
		this.callback(
			[
				{
					target,
					contentRect: { width } as DOMRectReadOnly,
				} as ResizeObserverEntry,
			],
			this,
		);
	}
}

function createSingletonSurfaces(): SingletonSurfaceRegistry {
	return new SingletonSurfaceRegistry({
		createCommit: () => new CommitController({}),
		createPullRequests: () => new PullRequestsStore(),
		gitBranchActions: new GitBranchSelectorState(),
		gitMutations: { run: vi.fn() } as never,
		getCurrentEffectiveProjectKey: () => '/canonical/project',
	});
}

function singletonController(
	registry: SingletonSurfaceRegistry,
	kind: Exclude<Extract<SurfaceDescriptor, { type: 'singleton' }>['kind'], 'chat'>,
): unknown {
	switch (kind) {
		case 'git':
			return registry.git();
		case 'files':
			return registry.files();
		case 'pull-requests':
			return registry.pullRequests();
		case 'commit':
			return registry.commit();
	}
}

function withAdditionalSurfaces(): WorkspaceLayoutSnapshot {
	const base = canonicalWorkspaceSnapshot();
	return {
		...base,
		main: {
			order: [...base.main.order, 'terminal:one'],
			activeId: CHAT_SURFACE_ID,
			mru: [...base.main.mru, 'terminal:one'],
		},
		sidebar: {
			order: [...base.sidebar.order, 'file:one'],
			activeId: 'singleton:files',
			mru: [...base.sidebar.mru, 'file:one'],
		},
		surfaces: {
			...base.surfaces,
			'terminal:one': { id: 'terminal:one', type: 'terminal', terminalId: 'one' },
			'file:one': { id: 'file:one', type: 'file', fileSessionId: 'one' },
		},
		sidebarOpen: true,
	};
}

function minimalGitSnapshot(): WorkspaceLayoutSnapshot {
	return {
		main: {
			order: [CHAT_SURFACE_ID, 'singleton:git'],
			activeId: 'singleton:git',
			mru: ['singleton:git', CHAT_SURFACE_ID],
		},
		sidebar: { order: [], activeId: null, mru: [] },
		surfaces: {
			[CHAT_SURFACE_ID]: { id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' },
			'singleton:git': { id: 'singleton:git', type: 'singleton', kind: 'git' },
		},
		sidebarOpen: false,
		desiredSidebarWidth: 480,
		dialogFileSurfaceId: null,
		manualFullscreen: false,
		mobileActiveSurfaceId: 'singleton:git',
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
	};
}

function createWorkspace(initial: WorkspaceLayoutSnapshot) {
	const layout = new WorkspaceLayoutStore(initial);
	const commit = (mutations: readonly WorkspaceLayoutMutation[]): void => {
		const next = reduceWorkspaceLayout(layout.snapshot, mutations);
		if (!layout.publish(layout.revision, next)) throw new Error('Test layout publication failed');
	};
	const hostFor = (surfaceId: string): HostId | null => {
		if (layout.snapshot.main.order.includes(surfaceId)) return 'main';
		if (layout.snapshot.sidebar.order.includes(surfaceId)) return 'sidebar';
		return null;
	};

	return {
		layout,
		attachmentErrors: {} as Record<string, string>,
		get activeMainId() {
			return layout.activeMainId;
		},
		get canOpenSidebar() {
			return layout.snapshot.sidebar.order.length > 0;
		},
		get isChatPresented() {
			return (
				layout.snapshot.mobileActiveSurfaceId === CHAT_SURFACE_ID ||
				layout.activeMainId === CHAT_SURFACE_ID
			);
		},
		get isChatInteractive() {
			return this.isChatPresented;
		},
		setSidebarOverlayMode: vi.fn(),
		noteSurfaceFocus: vi.fn(),
		noteHostChromeFocus: vi.fn(),
		frameVersion: vi.fn(() => 0),
		isSurfaceCloseBlocked: vi.fn(() => false),
		retryPresentation: vi.fn(async () => undefined),
		setSidebarWidth: vi.fn(async (width: number) => commit([{ type: 'set-sidebar-width', width }])),
		openSidebar: vi.fn(async () => commit([{ type: 'set-sidebar-open', open: true }])),
		closeSidebar: vi.fn(async () => commit([{ type: 'set-sidebar-open', open: false }])),
		focusSurface: vi.fn(async (surfaceId: string) => {
			const host = hostFor(surfaceId);
			if (host) commit([{ type: 'focus-host', host, surfaceId }]);
		}),
		moveSurface: vi.fn(async (surfaceId: string, destination: HostId) => {
			commit([{ type: 'move-to-host', surfaceId, destination }]);
			return true;
		}),
		closeSurface: vi.fn(async (surfaceId: string) => {
			commit([{ type: 'remove-surface', surfaceId }]);
			return true;
		}),
		popOutFile: vi.fn(async () => true),
		openSingleton: vi.fn(async () => undefined),
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
	TestResizeObserver.instances = [];
	vi.stubGlobal('ResizeObserver', TestResizeObserver);
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
			presentation: 'main' as const,
			visible: true,
			onSendToChat: vi.fn(async () => true),
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
			const source: HostId = workspace.layout.snapshot.main.order.includes(surfaceId)
				? 'main'
				: 'sidebar';
			const destination: HostId = source === 'main' ? 'sidebar' : 'main';
			const tab = document.getElementById(`${source}-tab-${surfaceId}`);
			expect(tab).toBeTruthy();
			await fireEvent.click(tab!);
			await waitFor(() => expect(workspace.layout.snapshot[source].activeId).toBe(surfaceId));
			expect(container.querySelector(`[data-workspace-surface-id="${surfaceId}"]`)).toBeTruthy();

			await workspace.moveSurface(surfaceId, destination);
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

	it('keeps Chat mounted across push, overlay, sidebar close, and sidebar reopen', async () => {
		const { workspace } = installContext();
		const onOverlayModalChange = vi.fn();
		const { container } = render(WorkspaceRoot, {
			isMobile: false,
			chatActions,
			onOverlayModalChange,
		});
		const hostRegion = container.querySelector<HTMLElement>('.workspace-host-region')!;
		const chatNode = container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`);
		expect(chatNode).toBeTruthy();
		const resizeBoundary = container.querySelector<HTMLElement>(
			'[data-right-sidebar-resize-boundary]',
		);
		expect(resizeBoundary).toBeTruthy();
		expect(resizeBoundary?.classList.contains('z-[45]')).toBe(true);
		expect(resizeBoundary?.style.getPropertyValue('inset-inline-end')).toBe('480px');
		expect(screen.queryByRole('dialog', { name: 'Workspace sidebar' })).toBeNull();
		expect(onOverlayModalChange).not.toHaveBeenCalled();

		const rootObserver = TestResizeObserver.instances.find((observer) =>
			observer.observed.has(hostRegion),
		);
		expect(rootObserver).toBeTruthy();
		rootObserver!.emit(hostRegion, 700);
		const dialog = await screen.findByRole('dialog', { name: 'Workspace sidebar' });
		const backdrop = container.querySelector<HTMLButtonElement>(
			'[data-workspace-sidebar-backdrop]',
		)!;
		expect(backdrop).toBeTruthy();
		await waitFor(() => expect(onOverlayModalChange).toHaveBeenLastCalledWith(true));
		expect(container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`)).toBe(
			chatNode,
		);
		const dialogFocusable = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
			),
		);
		for (const element of [backdrop, ...dialogFocusable]) {
			Object.defineProperty(element, 'offsetParent', {
				configurable: true,
				value: dialog,
			});
		}
		const lastDialogControl = dialogFocusable.at(-1)!;
		backdrop.focus();
		await fireEvent.keyDown(backdrop, { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(lastDialogControl);
		await fireEvent.keyDown(lastDialogControl, { key: 'Tab' });
		expect(document.activeElement).toBe(backdrop);

		rootObserver!.emit(hostRegion, 1_400);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(container.querySelector('[data-right-sidebar-resize-boundary]')).toBeTruthy();
		await waitFor(() => expect(onOverlayModalChange).toHaveBeenLastCalledWith(false));
		expect(onOverlayModalChange.mock.calls).toEqual([[true], [false]]);

		await workspace.closeSidebar();
		await tick();
		expect(container.querySelector('aside')?.getAttribute('aria-hidden') ?? 'true').toBe('true');
		expect(container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`)).toBe(
			chatNode,
		);

		await workspace.openSidebar();
		await tick();
		expect(container.querySelector('aside')?.getAttribute('aria-hidden')).toBe('false');
		expect(container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`)).toBe(
			chatNode,
		);
		expect(screen.queryByText(/unsafe state mutation/i)).toBeNull();
	});

	it('hands a retained renderer across desktop and mobile without duplicate attachment', async () => {
		const { workspace, surfaceFrames } = installContext(minimalGitSnapshot());
		const desktopExpectation = surfaceFrames.beginTransfer('singleton:git', 'main');
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

		const returnedDesktopExpectation = surfaceFrames.beginTransfer('singleton:git', 'main');
		await rendered.rerender({ isMobile: false, chatActions });
		const returnedDesktopFrame = await surfaceFrames.waitFor(returnedDesktopExpectation);
		await returnedDesktopFrame.attachRetainedRenderer();
		await waitFor(() => expect(surfaceRendererTestProbe.attached).toBe(1));
		expect(surfaceRendererTestProbe.maximumAttached).toBe(1);
		expect(workspace.layout.snapshot.main.activeId).toBe('singleton:git');
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
		expect(workspace.retryPresentation).toHaveBeenCalledWith('singleton:git', 'main');
		expect(container.querySelector(`[data-workspace-surface-id="${CHAT_SURFACE_ID}"]`)).toBe(
			chatNode,
		);
	});
});
