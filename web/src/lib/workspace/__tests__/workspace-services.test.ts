import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
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
import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';
import { windowIdOfSurface, windowNodeById } from '../window-tree.js';
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

const DEFAULT_WINDOW: WorkspaceWindowId = 'window-main';
const OTHER_WINDOW: WorkspaceWindowId = 'window-2';

function assembleWorkspaceServices(localSettings: LocalSettingsStore): {
	services: WorkspaceServices;
	ghCapability: ReturnType<typeof createGhCapabilityStore>;
} {
	const ghCapability = createGhCapabilityStore();
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
			chatSessions: createChatSessionsStore(),
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

	it('cancels root-owned window drag before a main-inert transition', () => {
		rootLocalSettings = createLocalSettingsStore();
		({ services } = assembleWorkspaceServices(rootLocalSettings));
		services.windowDnd.beginChatDrag('chat-dragged');
		expect(services.windowDnd.isDragging).toBe(true);

		const element = document.createElement('div');
		document.body.append(element);
		let unregister = () => undefined;
		services.transientLayers.open('main-inert', () => {
			unregister = services!.transientLayers.register({
				id: 'test-dialog',
				kind: 'application-dialog',
				modality: 'main-inert',
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
