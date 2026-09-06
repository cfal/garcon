import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { ApiError } from '$lib/api/client.js';
import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { createGhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
import {
	createLocalSettingsStore,
	type LocalSettingsStore,
} from '$lib/stores/local-settings.svelte.js';
import { createModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import { createNavigationStore } from '$lib/stores/navigation.svelte.js';
import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte.js';
import type { ChatListEntry } from '$shared/chat-list';
import type { ProjectTarget } from '$shared/project-resolution';
import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
import { windowIdOfSurface, windowNodeById } from '../window-tree.js';
import {
	MIN_WINDOW_WIDTH_PX,
	WORKSPACE_RESIZE_BOUND_SAFETY_PX,
} from '../window-geometry-policy.js';
import {
	createWorkspaceServices,
	resolveConfiguredFilePlacement,
	type WorkspaceServices,
} from '../workspace-services.js';

vi.mock('$lib/api/files.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/files.js')>();
	return {
		...actual,
		resolveFileIdentity: vi.fn(
			async ({
				projectPath,
				relativePath,
			}: {
				projectPath: string | null;
				relativePath: string;
			}) => ({
				success: true as const,
				identity: {
					canonicalFileRootPath: projectPath ?? '/workspace',
					normalizedRelativePath: relativePath,
				},
			}),
		),
		readText: vi.fn(async ({ filePath }: { filePath: string }) => ({
			content: '',
			path: `/workspace/${filePath}`,
			revision: `v1:${filePath}`,
		})),
	};
});

const projectResolutionApiMocks = vi.hoisted(() => ({ resolveProject: vi.fn() }));

vi.mock('$lib/api/project-resolution.js', () => ({
	resolveProject: projectResolutionApiMocks.resolveProject,
}));

const DEFAULT_WINDOW: WorkspaceWindowId = 'window-main';
const OTHER_WINDOW: WorkspaceWindowId = 'window-2';

function assembleWorkspaceServices(localSettings: LocalSettingsStore): {
	services: WorkspaceServices;
	ghCapability: ReturnType<typeof createGhCapabilityStore>;
	chatSessions: ReturnType<typeof createChatSessionsStore>;
} {
	const ghCapability = createGhCapabilityStore();
	const chatSessions = createChatSessionsStore();
	ghCapability.hasChecked = true;
	ghCapability.available = true;
	const ws = {
		isConnected: false,
		sendMessage: () => false,
		addMessageConsumer: () => () => undefined,
		onConnectionChange: () => () => undefined,
	} satisfies PrimaryWsConnectionPort;
	return {
		services: createWorkspaceServices({
			appShell: createAppShellStore(),
			chatSessions,
			ghCapability,
			localSettings,
			modelCatalog: createModelCatalogStore(),
			navigation: createNavigationStore(),
			notifications: createNotificationsStore(),
			terminalIdentity: { clientId: 'test-client' },
			ws,
			getRouteIdentity: () => '/',
			onTerminalLauncherDismissed: () => {},
			isTerminalLauncherDismissed: () => false,
			workspaceLayoutRaw: null,
		}),
		ghCapability,
		chatSessions,
	};
}

describe('createWorkspaceServices', () => {
	let services: WorkspaceServices | null = null;
	let rootLocalSettings: LocalSettingsStore | null = null;

	afterEach(() => {
		services?.destroy();
		services = null;
		rootLocalSettings?.destroy();
		rootLocalSettings = null;
		projectResolutionApiMocks.resolveProject.mockReset();
	});

	it.each([
		['code', 'window-main'],
		['image', 'window-main'],
		['markdown', 'window-2'],
	] as const)('resolves source placement for %s from origin %s', (mode, origin) => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(
			resolveConfiguredFilePlacement(
				localSettings,
				mode,
				origin as WorkspaceWindowId,
				DEFAULT_WINDOW,
			),
		).toEqual({ type: 'window', windowId: origin });

		localSettings.destroy();
	});

	it('resolves fixed placements independent of origin and observes setting changes', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		localSettings.set('textEditorOpenPlacement', 'new-window');
		localSettings.set('imageViewerOpenPlacement', 'same-window');
		localSettings.set('markdownViewerOpenPlacement', 'dialog');

		expect(resolveConfiguredFilePlacement(localSettings, 'code', 'dialog', DEFAULT_WINDOW)).toEqual(
			{ type: 'new-window', anchorWindowId: DEFAULT_WINDOW },
		);
		expect(
			resolveConfiguredFilePlacement(localSettings, 'image', OTHER_WINDOW, DEFAULT_WINDOW),
		).toEqual({ type: 'window', windowId: OTHER_WINDOW });
		expect(
			resolveConfiguredFilePlacement(localSettings, 'markdown', OTHER_WINDOW, DEFAULT_WINDOW),
		).toEqual({ type: 'dialog' });

		localSettings.destroy();
	});

	it('falls back to the default window when the origin is not a window', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(
			resolveConfiguredFilePlacement(localSettings, 'markdown', 'mobile', DEFAULT_WINDOW),
		).toEqual({ type: 'window', windowId: DEFAULT_WINDOW });
		expect(
			resolveConfiguredFilePlacement(localSettings, 'markdown', 'dialog', DEFAULT_WINDOW),
		).toEqual({ type: 'window', windowId: DEFAULT_WINDOW });

		localSettings.destroy();
	});

	it('routes new-window file opens through the assembled registry and coordinator', async () => {
		localStorage.clear();
		rootLocalSettings = createLocalSettingsStore();
		rootLocalSettings.set('textEditorOpenPlacement', 'new-window');
		({ services } = assembleWorkspaceServices(rootLocalSettings));

		const opening = services.files.open({
			fileRootPath: '/workspace',
			relativePath: 'from-main.ts',
			mode: 'code',
			origin: 'window-main',
			reason: 'user-open',
		});
		await vi.waitFor(() => {
			const snapshot = services!.layout.snapshot;
			const fileSurface = Object.keys(snapshot.surfaces).find((id) => id.startsWith('file:'));
			expect(fileSurface).toBeDefined();
			const windowId = windowIdOfSurface(snapshot.desktopRoot, fileSurface!);
			expect(windowId).not.toBeNull();
			expect(windowId).not.toBe('window-main');
		});
		const snapshot = services.layout.snapshot;
		const placedSurfaceId = Object.keys(snapshot.surfaces).find((id) => id.startsWith('file:'))!;
		const windowId = windowIdOfSurface(snapshot.desktopRoot, placedSurfaceId)!;
		services.surfaceFrames.register(placedSurfaceId, windowId, {
			element: document.createElement('div'),
			attachRetainedRenderer: () => {},
			focusPrimary: () => {},
		});
		const opened = await opening;
		if (!opened) throw new Error('Expected file to open');
		await vi.waitFor(() => {
			expect(windowNodeById(services!.layout.snapshot.desktopRoot, windowId)?.tabs.activeId).toBe(
				placedSurfaceId,
			);
		});
	});

	it('assembles the coordinator and keeps root-owned domain bindings reactive', async () => {
		rootLocalSettings = createLocalSettingsStore();
		rootLocalSettings.showQuickCommitTray = false;
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		const { ghCapability } = assembled;
		await tick();

		expect(services.restore.source).toBe('absent');
		expect(services.coordinator.layout).toBe(services.layout);
		expect(
			windowNodeById(services.layout.snapshot.desktopRoot, DEFAULT_WINDOW)?.tabs.order[0],
		).toBe('chat-view:window-main');
		expect(services.workspaceInteractionGate).toBeDefined();
		expect(services.surfaceFrames).toBeDefined();
		expect(services.shortcuts).toBeDefined();
		expect(services.gitQuickSummary.isEnabled).toBe(false);
		expect(services.singletonSurfaces.pullRequests().capabilityState).toBe('available');

		rootLocalSettings.showQuickCommitTray = true;
		ghCapability.available = false;
		await tick();

		expect(services.gitQuickSummary.isEnabled).toBe(true);
		expect(services.singletonSurfaces.pullRequests().capabilityState).toBe('unavailable');
	});

	it('does not resolve the selected project again for record-only chat updates', async () => {
		projectResolutionApiMocks.resolveProject.mockImplementation(async (target: ProjectTarget) => ({
			target,
			resolution: { kind: 'available' as const, effectiveProjectKey: target.projectPath },
		}));
		rootLocalSettings = createLocalSettingsStore();
		rootLocalSettings.showQuickCommitTray = false;
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		const entry: ChatListEntry = {
			id: '1788698026082000',
			parentChat: null,
			agentId: 'codex',
			agentOwnershipEpoch: 'epoch-1',
			model: 'default',
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
			title: 'Project chat',
			projectPath: '/workspace/project',
			orderGroup: 'normal',
			tags: [],
			activity: {
				createdAt: '2026-09-06T00:00:00.000Z',
				lastActivityAt: '2026-09-06T00:00:00.000Z',
				lastReadAt: '2026-09-06T00:00:00.000Z',
			},
			preview: { lastMessage: 'Initial preview' },
			isPinned: false,
			isArchived: false,
			isActive: false,
			isProcessing: false,
			processingPhase: null,
			canReloadFromNativeHistory: false,
			isUnread: false,
		};
		assembled.chatSessions.upsertServerChat(entry);
		assembled.chatSessions.setSelectedChatId(entry.id);
		await vi.waitFor(() => expect(projectResolutionApiMocks.resolveProject).toHaveBeenCalledOnce());
		assembled.chatSessions.patchPreview(entry.id, 'Streaming preview');
		assembled.chatSessions.patchActivity(entry.id, '2026-09-06T00:00:01.000Z');
		assembled.chatSessions.applyProcessingEvent(entry.id, 'running');
		await tick();

		expect(projectResolutionApiMocks.resolveProject).toHaveBeenCalledOnce();
	});

	it('keeps a resolved destination when an old binding requests a metadata refresh', async () => {
		const oldTarget = {
			kind: 'chat',
			chatId: '1788698026082000',
			projectPath: '/workspace/old-project',
		} as const;
		const destination = { ...oldTarget, projectPath: '/workspace/new-project' } as const;
		const oldResult = Promise.withResolvers<never>();
		projectResolutionApiMocks.resolveProject.mockImplementation(async (requested: ProjectTarget) => {
			if (requested.projectPath === oldTarget.projectPath) return oldResult.promise;
			return {
				target: requested,
				resolution: {
					kind: 'available' as const,
					effectiveProjectKey: '/real/new-project',
				},
			};
		});
		rootLocalSettings = createLocalSettingsStore();
		const assembled = assembleWorkspaceServices(rootLocalSettings);
		services = assembled.services;
		const refresh = vi
			.spyOn(assembled.chatSessions, 'quietRefreshChats')
			.mockResolvedValue(undefined);
		const oldLease = services.projectResolution.retain(oldTarget);
		const destinationLease = services.projectResolution.retain(destination);
		const oldPending = oldLease.resolve();
		await destinationLease.resolve();

		oldResult.reject(new ApiError(409, 'changed', 'PROJECT_PATH_CHANGED'));
		await oldPending;

		expect(oldLease.snapshot).toEqual({ kind: 'request-failed', message: 'changed' });
		expect(destinationLease.snapshot).toEqual({
			kind: 'available',
			effectiveProjectKey: '/real/new-project',
		});
		expect(refresh).toHaveBeenCalledOnce();
		oldLease.release();
		destinationLease.release();
	});

	it('resolves partition bounds from the shared host measurement', async () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		const hostWidth = 1200;
		services.hostGeometry.size = { width: hostWidth, height: 500 };
		await services.coordinator.openChatInNewWindow('chat-2');
		const root = services.layout.snapshot.desktopRoot;
		if (root.type !== 'partition') throw new Error('Expected partition root');
		const requiredWidth = MIN_WINDOW_WIDTH_PX + WORKSPACE_RESIZE_BOUND_SAFETY_PX;

		expect(services.coordinator.resolvePartitionRatioBounds(root.id)).toEqual({
			min: requiredWidth / (hostWidth * 0.5),
			max: 1 - requiredWidth / hostWidth,
			adjustable: true,
		});
	});

	it('cancels root-owned window drag before a main-inert transition', () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		services.windowDnd.beginChatDrag('chat-dragged');
		expect(services.windowDnd.isDragging).toBe(true);

		const element = document.createElement('div');
		document.body.append(element);
		let unregister: () => void = () => undefined;
		services.transientLayers.open('main-inert', () => {
			unregister = services!.transientLayers.register({
				id: 'test-dialog',
				kind: 'application-dialog',
				modality: 'main-inert',
				isOpen: () => true,
				element: () => element,
				onEscape: () => true,
				restoreFocus: () => undefined,
			});
		});

		expect(services.windowDnd.isDragging).toBe(false);
		unregister();
		element.remove();
	});
});
