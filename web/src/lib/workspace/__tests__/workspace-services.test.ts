import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { createGhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import { createModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import { createNavigationStore } from '$lib/stores/navigation.svelte.js';
import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte.js';
import {
	createWorkspaceServices,
	resolveConfiguredFilePlacement,
	type WorkspaceServices,
} from '../workspace-services.js';

describe('createWorkspaceServices', () => {
	let services: WorkspaceServices | null = null;

	afterEach(() => {
		services?.destroy();
		services = null;
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

	it('uses main as the desktop fallback for a mobile source origin', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(resolveConfiguredFilePlacement(localSettings, 'markdown', 'mobile')).toBe('main');
		localSettings.destroy();
	});

	it('assembles the coordinator and keeps root-owned domain bindings reactive', async () => {
		const ghCapability = createGhCapabilityStore();
		ghCapability.hasChecked = true;
		ghCapability.available = true;
		const localSettings = createLocalSettingsStore();
		localSettings.showQuickCommitTray = false;
		const ws = {
			isConnected: false,
			sendMessage: () => false,
			addMessageConsumer: () => () => undefined,
			onConnectionChange: () => () => undefined,
		} satisfies PrimaryWsConnectionPort;
		services = createWorkspaceServices({
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
		});
		await tick();

		expect(services.restore.source).toBe('absent');
		expect(services.coordinator.layout).toBe(services.layout);
		expect(services.layout.snapshot.main.order[0]).toBe('singleton:chat');
		expect(services.chatInteractionGate).toBeDefined();
		expect(services.surfaceFrames).toBeDefined();
		expect(services.shortcuts).toBeDefined();
		expect(services.gitQuickSummary.isEnabled).toBe(false);
		expect(services.singletonSurfaces.pullRequests().capabilityState).toBe('available');

		localSettings.showQuickCommitTray = true;
		ghCapability.available = false;
		await tick();

		expect(services.gitQuickSummary.isEnabled).toBe(true);
		expect(services.singletonSurfaces.pullRequests().capabilityState).toBe('unavailable');
	});
});
