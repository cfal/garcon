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
import { fileSurfaceId } from '$lib/workspace/surface-types.js';
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
		['code', 'main', 'main'],
		['code', 'sidebar', 'sidebar'],
		['code', 'dialog', 'dialog'],
		['image', 'main', 'main'],
		['image', 'sidebar', 'sidebar'],
		['image', 'dialog', 'dialog'],
		['markdown', 'main', 'main'],
		['markdown', 'sidebar', 'sidebar'],
		['markdown', 'dialog', 'dialog'],
	] as const)('resolves source %s from %s to %s', (mode, origin, expected) => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(resolveConfiguredFilePlacement(localSettings, mode, origin)).toBe(expected);
		localSettings.destroy();
	});

	it('keeps fixed placements independent of origin and observes setting changes', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		localSettings.set('textEditorOpenPlacement', 'main');
		localSettings.set('imageViewerOpenPlacement', 'sidebar');
		localSettings.set('markdownViewerOpenPlacement', 'dialog');

		expect(resolveConfiguredFilePlacement(localSettings, 'code', 'dialog')).toBe('main');
		expect(resolveConfiguredFilePlacement(localSettings, 'image', 'main')).toBe('sidebar');
		expect(resolveConfiguredFilePlacement(localSettings, 'markdown', 'sidebar')).toBe('dialog');

		localSettings.set('textEditorOpenPlacement', 'source');
		expect(resolveConfiguredFilePlacement(localSettings, 'code', 'sidebar')).toBe('sidebar');
		localSettings.destroy();
	});

	it('opens each renderer in the other desktop view and falls back to main without one', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		localSettings.set('textEditorOpenPlacement', 'other');
		localSettings.set('imageViewerOpenPlacement', 'other');
		localSettings.set('markdownViewerOpenPlacement', 'other');

		expect(resolveConfiguredFilePlacement(localSettings, 'code', 'main')).toBe('sidebar');
		expect(resolveConfiguredFilePlacement(localSettings, 'code', 'sidebar')).toBe('main');
		expect(resolveConfiguredFilePlacement(localSettings, 'image', 'main')).toBe('sidebar');
		expect(resolveConfiguredFilePlacement(localSettings, 'image', 'sidebar')).toBe('main');
		expect(resolveConfiguredFilePlacement(localSettings, 'markdown', 'main')).toBe('sidebar');
		expect(resolveConfiguredFilePlacement(localSettings, 'markdown', 'sidebar')).toBe('main');
		expect(resolveConfiguredFilePlacement(localSettings, 'markdown', 'dialog')).toBe('main');
		expect(resolveConfiguredFilePlacement(localSettings, 'markdown', 'mobile')).toBe('main');
		localSettings.destroy();
	});

	it('uses main as the desktop fallback for a mobile source origin', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(resolveConfiguredFilePlacement(localSettings, 'markdown', 'mobile')).toBe('main');
		localSettings.destroy();
	});

	it('routes other-view file opens through the assembled registry and coordinator', async () => {
		localStorage.clear();
		rootLocalSettings = createLocalSettingsStore();
		rootLocalSettings.set('textEditorOpenPlacement', 'other');
		({ services } = assembleWorkspaceServices(rootLocalSettings));

		const openingFromMain = services.files.open({
			fileRootPath: '/workspace',
			relativePath: 'from-main.ts',
			mode: 'code',
			origin: 'main',
			reason: 'user-open',
		});
		await vi.waitFor(() => expect(services?.layout.snapshot.sidebar.activeId).toMatch(/^file:/));
		const sidebarSurfaceId = services.layout.snapshot.sidebar.activeId;
		if (!sidebarSurfaceId) throw new Error('Expected a sidebar file surface');
		services.surfaceFrames.register(sidebarSurfaceId, 'sidebar', {
			element: document.createElement('div'),
			attachRetainedRenderer: () => {},
			focusPrimary: () => {},
		});
		const fromMain = await openingFromMain;
		if (!fromMain) throw new Error('Expected main-origin file to open');
		expect(services.layout.snapshot.sidebar.order).toContain(fileSurfaceId(fromMain.id));
		expect(services.layout.snapshot.sidebarOpen).toBe(true);

		const openingFromSidebar = services.files.open({
			fileRootPath: '/workspace',
			relativePath: 'from-sidebar.ts',
			mode: 'code',
			origin: 'sidebar',
			reason: 'user-open',
		});
		await vi.waitFor(() => expect(services?.layout.snapshot.main.activeId).toMatch(/^file:/));
		const mainSurfaceId = services.layout.snapshot.main.activeId;
		if (!mainSurfaceId) throw new Error('Expected a main file surface');
		services.surfaceFrames.register(mainSurfaceId, 'main', {
			element: document.createElement('div'),
			attachRetainedRenderer: () => {},
			focusPrimary: () => {},
		});
		const fromSidebar = await openingFromSidebar;
		if (!fromSidebar) throw new Error('Expected sidebar-origin file to open');
		expect(services.layout.snapshot.main.order).toContain(fileSurfaceId(fromSidebar.id));
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
		expect(services.layout.snapshot.main.order[0]).toBe('singleton:chat');
		expect(services.chatInteractionGate).toBeDefined();
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
});
