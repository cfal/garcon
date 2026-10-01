<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import Settings from '../Settings.svelte';
	import {
		setAppShell,
		setChatSessions,
		setLocalSettings,
		setModelCatalog,
		setNotifications,
		setPreambles,
		setRemoteSettings,
		setScheduledPrompts,
		setSidebarSearch,
		setSnippets,
		setTransientLayers,
	} from '$lib/context';
	import type { AppShellStore } from '$lib/stores/app-shell.svelte';
	import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte';
	import type { SnippetsStore } from '$lib/snippets/snippets-store.svelte';
	import type { ScheduledPromptsStore } from '$lib/scheduling/scheduled-prompts-store.svelte';
	import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import { LocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
	import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte';
	import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';

	let {
		appShell,
		preambles,
		snippets,
		scheduledPrompts,
		remoteSettings,
	}: {
		appShell: AppShellStore;
		preambles: PreamblesStore;
		snippets: SnippetsStore;
		scheduledPrompts: ScheduledPromptsStore;
		remoteSettings: RemoteSettingsStore;
	} = $props();

	untrack(() => {
		setAppShell(appShell);
		setPreambles(preambles);
		setSnippets(snippets);
		setScheduledPrompts(scheduledPrompts);
		setRemoteSettings(remoteSettings);
	});
	setExecutorsTestContext();
	setChatSessions(new ChatSessionsStore());
	setNotifications(createNotificationsStore());
	const localSettings = new LocalSettingsStore();
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	setTransientLayers(transientLayers);
	const catalog = new ModelCatalogStore();
	catalog.agentModels = { claude: [{ value: 'opus', label: 'Opus' }] };
	catalog.agentMetadata = {
		claude: {
			id: 'claude',
			label: 'Claude',
			supportsCompact: false,
			supportsFork: false,
			supportsForkAtMessage: false,
			supportsForkWhileRunning: false,
			supportsUpdateProjectPath: false,
			supportsSteering: false,
			supportsImages: false,
			fileAttachmentMimeTypes: [],
			acceptsApiProviderEndpoints: false,
			supportedProtocols: [],
			authLoginSupported: false,
			supportedPermissionModes: ['default'],
			supportedThinkingModes: ['none'],
			settings: [],
			defaultSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
			defaultModel: 'opus',
		},
	};
	catalog.lastValidatedAt = Date.now();
	setModelCatalog(catalog);
	setSidebarSearch(
		createSidebarSearchStore({
			getChats: () => [],
			getSelectedChatId: () => null,
			getTranscriptSearchEnabled: () => false,
			getSearchResultSort: () => 'relevance',
			notifyError: () => undefined,
		}),
	);
</script>

<svelte:window onkeydowncapture={(event) => transientLayers.handleEscape(event)} />

{#if appShell.showSettings}<Settings />{/if}
