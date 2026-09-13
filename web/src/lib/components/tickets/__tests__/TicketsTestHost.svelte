<script lang="ts">
	import { onMount } from 'svelte';
	import { setNotifications, setTransientLayers } from '$lib/context';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import {
		setSurfaceFrameBridge,
		SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import TicketsPanel from '../TicketsPanel.svelte';
	let {
		controller,
		frame = new SurfaceFrameBridge(),
		pinnedProjectPaths = [],
	}: {
		controller: TicketsController;
		frame?: SurfaceFrameBridge;
		pinnedProjectPaths?: string[];
	} = $props();
	setSurfaceFrameBridge(() => frame);
	setNotifications(createNotificationsStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
	onMount(() => {
		void frame.activate(false);
		return () => frame.deactivate();
	});
</script>

<TicketsPanel
	{controller}
	{pinnedProjectPaths}
	visible
	chats={[]}
	username="local"
	directory={null}
	onOpenChat={() => {}}
	onOpenSource={() => {}}
/>
