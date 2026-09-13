<script lang="ts">
	import { onMount } from 'svelte';
	import { setNotifications, setTransientLayers } from '$lib/context';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import {
		setSurfaceFrameBridge,
		SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import IssuesPanel from '../IssuesPanel.svelte';
	let {
		controller,
		frame = new SurfaceFrameBridge(),
		pinnedProjectPaths = [],
	}: {
		controller: IssuesController;
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

<IssuesPanel
	{controller}
	{pinnedProjectPaths}
	visible
	chats={[]}
	username="local"
	directory={null}
	onOpenChat={() => {}}
	onOpenSource={() => {}}
/>
