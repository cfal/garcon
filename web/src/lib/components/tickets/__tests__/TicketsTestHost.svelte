<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { setModelCatalog, setNotifications, setRemoteSettings, setTransientLayers } from '$lib/context';
	import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
	import { setTicketDispatchTestContext } from '$lib/tickets/dispatch/__tests__/ticket-dispatch-test-context';
	import type { TicketDispatchController } from '$lib/tickets/dispatch/ticket-dispatch-controller.svelte.js';
	import { setTicketDispatch } from '$lib/context/tickets-context.js';
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
		ticketDispatch,
	}: {
		controller: TicketsController;
		frame?: SurfaceFrameBridge;
		pinnedProjectPaths?: string[];
		chats?: readonly TicketChatSummary[];
		onOpenChat?: (id: string) => void;
		ticketDispatch?: TicketDispatchController;
	} = $props();
	setSurfaceFrameBridge(() => frame);
	setNotifications(createNotificationsStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
	setExecutorsTestContext();
	const modelCatalog = new ModelCatalogStore();
	const remoteSettings = new RemoteSettingsStore();
	remoteSettings.applySnapshot(makeRemoteSettingsSnapshot());
	setModelCatalog(modelCatalog);
	setRemoteSettings(remoteSettings);
	const providedDispatch = untrack(() => ticketDispatch);
	if (providedDispatch) setTicketDispatch(providedDispatch);
	else setTicketDispatchTestContext({ remoteSettings, modelCatalog });
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
