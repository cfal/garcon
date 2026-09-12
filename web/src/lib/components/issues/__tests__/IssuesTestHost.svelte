<script lang="ts">
	import { onMount } from 'svelte';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import {
		setSurfaceFrameBridge,
		SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import IssuesPanel from '../IssuesPanel.svelte';
	let {
		controller,
		frame = new SurfaceFrameBridge(),
	}: { controller: IssuesController; frame?: SurfaceFrameBridge } = $props();
	setSurfaceFrameBridge(() => frame);
	onMount(() => {
		void frame.activate(false);
		return () => frame.deactivate();
	});
</script>

<IssuesPanel
	{controller}
	visible
	chats={[]}
	username="local"
	directory={null}
	onOpenChat={() => {}}
	onOpenSource={() => {}}
/>
