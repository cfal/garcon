import { afterEach, describe, expect, it } from 'vitest';
import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
import { createAuthStore } from '$lib/stores/auth.svelte.js';
import { createChatSessionsStore } from '$lib/stores/chat-sessions.svelte.js';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import { createModelCatalogStore } from '$lib/stores/model-catalog.svelte.js';
import { createNavigationStore } from '$lib/stores/navigation.svelte.js';
import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
import {
	createWorkspaceServices,
	type WorkspaceServices,
} from '../workspace-services.js';

describe('createWorkspaceServices', () => {
	let services: WorkspaceServices | null = null;

	afterEach(() => {
		services?.destroy();
		services = null;
	});

	it('assembles the coordinator and registries around one layout store', () => {
		services = createWorkspaceServices({
			auth: createAuthStore(),
			appShell: createAppShellStore(),
			chatSessions: createChatSessionsStore(),
			localSettings: createLocalSettingsStore(),
			modelCatalog: createModelCatalogStore(),
			navigation: createNavigationStore(),
			notifications: createNotificationsStore(),
			terminalIdentity: { clientId: 'test-client' },
			getRouteIdentity: () => '/',
			onTerminalLauncherDismissed: () => {},
			workspaceLayoutRaw: null,
		});

		expect(services.restore.source).toBe('absent');
		expect(services.coordinator.layout).toBe(services.layout);
		expect(services.layout.snapshot.main.order[0]).toBe('singleton:chat');
		expect(services.chatInteractionGate).toBeDefined();
		expect(services.surfaceFrames).toBeDefined();
		expect(services.shortcuts).toBeDefined();
	});
});
