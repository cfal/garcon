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
import { fileSurfaceId, type PaneId } from '$lib/workspace/surface-types.js';
import { paneIdOfSurface, paneNodeById } from '../pane-tree.js';
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

const DEFAULT_PANE: PaneId = 'pane-main';
const OTHER_PANE: PaneId = 'pane-2';

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
			workspaceLayoutV1Raw: null,
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
		['code', 'pane-main'],
		['image', 'pane-main'],
		['markdown', 'pane-2'],
	] as const)('resolves source placement for %s from origin %s', (mode, origin) => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(
			resolveConfiguredFilePlacement(localSettings, mode, origin as PaneId, DEFAULT_PANE),
		).toEqual({ type: 'pane', paneId: origin });

		localSettings.destroy();
	});

	it('resolves fixed placements independent of origin and observes setting changes', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		localSettings.set('textEditorOpenPlacement', 'new-pane');
		localSettings.set('imageViewerOpenPlacement', 'source');
		localSettings.set('markdownViewerOpenPlacement', 'dialog');

		expect(
			resolveConfiguredFilePlacement(localSettings, 'code', 'dialog', DEFAULT_PANE),
		).toEqual({ type: 'new-pane', anchorPaneId: DEFAULT_PANE });
		expect(
			resolveConfiguredFilePlacement(localSettings, 'image', OTHER_PANE, DEFAULT_PANE),
		).toEqual({ type: 'pane', paneId: OTHER_PANE });
		expect(
			resolveConfiguredFilePlacement(localSettings, 'markdown', OTHER_PANE, DEFAULT_PANE),
		).toEqual({ type: 'dialog' });

		localSettings.destroy();
	});

	it('falls back to the default pane when the origin is not a pane', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(
			resolveConfiguredFilePlacement(localSettings, 'markdown', 'mobile', DEFAULT_PANE),
		).toEqual({ type: 'pane', paneId: DEFAULT_PANE });
		expect(
			resolveConfiguredFilePlacement(localSettings, 'markdown', 'dialog', DEFAULT_PANE),
		).toEqual({ type: 'pane', paneId: DEFAULT_PANE });

		localSettings.destroy();
	});

	it('migrates legacy host placements to pane semantics', () => {
		localStorage.clear();
		localStorage.setItem(
			'pref_local_settings',
			JSON.stringify({
				textEditorOpenPlacement: 'main',
				imageViewerOpenPlacement: 'sidebar',
				markdownViewerOpenPlacement: 'other',
			}),
		);
		const localSettings = createLocalSettingsStore();

		expect(localSettings.textEditorOpenPlacement).toBe('source');
		expect(localSettings.imageViewerOpenPlacement).toBe('new-pane');
		expect(localSettings.markdownViewerOpenPlacement).toBe('new-pane');

		localSettings.destroy();
	});

	it('routes new-pane file opens through the assembled registry and coordinator', async () => {
		localStorage.clear();
		rootLocalSettings = createLocalSettingsStore();
		rootLocalSettings.set('textEditorOpenPlacement', 'new-pane');
		({ services } = assembleWorkspaceServices(rootLocalSettings));

		const opening = services.files.open({
			fileRootPath: '/workspace',
			relativePath: 'from-main.ts',
			mode: 'code',
			origin: 'pane-main',
			reason: 'user-open',
		});
		await vi.waitFor(() => {
			const snapshot = services!.layout.snapshot;
			const fileSurface = Object.keys(snapshot.surfaces).find((id) => id.startsWith('file:'));
			expect(fileSurface).toBeDefined();
			const paneId = paneIdOfSurface(snapshot.desktopRoot, fileSurface!);
			expect(paneId).not.toBeNull();
			expect(paneId).not.toBe('pane-main');
		});
		const snapshot = services.layout.snapshot;
		const placedSurfaceId = Object.keys(snapshot.surfaces).find((id) => id.startsWith('file:'))!;
		const paneId = paneIdOfSurface(snapshot.desktopRoot, placedSurfaceId)!;
		services.surfaceFrames.register(placedSurfaceId, paneId, {
			element: document.createElement('div'),
			attachRetainedRenderer: () => {},
			focusPrimary: () => {},
		});
		const opened = await opening;
		if (!opened) throw new Error('Expected file to open');
		await vi.waitFor(() => {
			expect(paneNodeById(services!.layout.snapshot.desktopRoot, paneId)?.tabs.activeId).toBe(
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
			paneNodeById(services.layout.snapshot.desktopRoot, DEFAULT_PANE)?.tabs.order[0],
		).toBe('singleton:chat');
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
