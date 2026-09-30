<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { setNotifications, setTransientLayers } from '$lib/context';
	import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
	import { TicketChatController } from '$lib/tickets/chat/ticket-chat-controller.svelte.js';
	import { AppShellStore } from '$lib/stores/app-shell.svelte';
	import { setTicketChat } from '$lib/context/tickets-context.js';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import {
		setSurfaceFrameBridge,
		SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import TicketsPanel from '../TicketsPanel.svelte';
	import type { TicketChatSummary } from '../ticket-presentation.js';
	let {
		controller,
		frame = new SurfaceFrameBridge(),
		pinnedProjectPaths = [],
		chats = [],
		onOpenChat = () => {},
		appShell,
	}: {
		controller: TicketsController;
		frame?: SurfaceFrameBridge;
		pinnedProjectPaths?: string[];
		chats?: readonly TicketChatSummary[];
		onOpenChat?: (id: string) => void;
		appShell?: AppShellStore;
	} = $props();
	setSurfaceFrameBridge(() => frame);
	setNotifications(createNotificationsStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
	const remoteSettings = new RemoteSettingsStore();
	remoteSettings.applySnapshot(makeRemoteSettingsSnapshot());
	setTicketChat(new TicketChatController({
		appShell: untrack(() => appShell) ?? new AppShellStore(),
		remoteSettings,
		notifications: createNotificationsStore(),
	}));
	onMount(() => {
		void frame.activate(false);
		return () => frame.deactivate();
	});
</script>

<TicketsPanel
	{controller}
	{pinnedProjectPaths}
	visible
	{chats}
	username="local"
	directory={null}
	{onOpenChat}
	onOpenSource={() => {}}
/>
