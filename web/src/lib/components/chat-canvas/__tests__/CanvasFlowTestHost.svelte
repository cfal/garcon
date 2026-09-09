<script lang="ts">
	import { SvelteFlowProvider, type useStore } from '@xyflow/svelte';
	import type { CanvasSession } from '$lib/chat-canvas/canvas-session.svelte';
	import { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte';
	import { setCanvasView } from '$lib/context/canvas-context';
	import CanvasFlow from '../CanvasFlow.svelte';
	import type { CanvasFlowNode } from '../canvas-node-types';
	import CanvasFlowStoreProbe from './CanvasFlowStoreProbe.svelte';
	let {
		session,
		editing = true,
		onstore,
	}: {
		session: CanvasSession;
		editing?: boolean;
		onstore?: (store: ReturnType<typeof useStore<CanvasFlowNode>>) => void;
	} = $props();
	const controller = new CanvasController();
	setCanvasView({
		get document() {
			return session.document;
		},
		chats: {},
		currentTime: new Date('2026-09-07T00:00:00Z'),
		get readOnly() {
			return !editing;
		},
		openChat: () => {},
	});
</script>

<SvelteFlowProvider>
	<CanvasFlow
		{session}
		{controller}
		selectedIds={new Set()}
		{editing}
		visible
		presentation="window-main"
		onselect={() => {}}
		onerror={(message) => {
			throw new Error(message);
		}}
	/>
	{#if onstore}<CanvasFlowStoreProbe {onstore} />{/if}
</SvelteFlowProvider>
