import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
import { createAuthStore } from '$lib/stores/auth.svelte.js';
import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { createGhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import { createModelCatalogStore } from '$lib/stores/model-catalog.svelte.js';
import { createNavigationStore } from '$lib/stores/navigation.svelte.js';
import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
import {
	configuredFilePlacement,
	createWorkspaceServices,
	type WorkspaceServices,
} from '../workspace-services.js';

describe('createWorkspaceServices', () => {
	let services: WorkspaceServices | null = null;

	afterEach(() => {
		services?.destroy();
		services = null;
	});

	it('reads renderer placement from the current local settings', () => {
		localStorage.clear();
		const localSettings = createLocalSettingsStore();

		expect(configuredFilePlacement(localSettings, 'code')).toBe('sidebar');
		expect(configuredFilePlacement(localSettings, 'image')).toBe('sidebar');
		expect(configuredFilePlacement(localSettings, 'markdown')).toBe('sidebar');

		localSettings.set('textEditorOpenPlacement', 'main');
		localSettings.set('imageViewerOpenPlacement', 'sidebar');
		localSettings.set('markdownViewerOpenPlacement', 'main');

		expect(configuredFilePlacement(localSettings, 'code')).toBe('main');
		expect(configuredFilePlacement(localSettings, 'image')).toBe('sidebar');
		expect(configuredFilePlacement(localSettings, 'markdown')).toBe('main');
		localSettings.destroy();
	});

	it('assembles the coordinator and keeps root-owned domain bindings reactive', async () => {
		const ghCapability = createGhCapabilityStore();
		ghCapability.hasChecked = true;
		ghCapability.available = true;
		const localSettings = createLocalSettingsStore();
		localSettings.showQuickCommitTray = false;
		services = createWorkspaceServices({
			auth: createAuthStore(),
			appShell: createAppShellStore(),
			chatSessions: createChatSessionsStore(),
			ghCapability,
			localSettings,
			modelCatalog: createModelCatalogStore(),
			navigation: createNavigationStore(),
			notifications: createNotificationsStore(),
			terminalIdentity: { clientId: 'test-client' },
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
