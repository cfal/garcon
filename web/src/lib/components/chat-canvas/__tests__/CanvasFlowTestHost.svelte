<script lang="ts">
	import { SvelteFlowProvider, type useStore } from '@xyflow/svelte';
	import type { CanvasSession } from '$lib/chat-canvas/canvas-session.svelte';
	import { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte';
	import { recoveryMemory } from '$lib/chat-canvas/__tests__/canvas-fixtures';
	import { setCanvasView } from '$lib/context/canvas-context';
	import CanvasFlow from '../CanvasFlow.svelte';
	import type { CanvasFlowNode } from '../canvas-node-types';
	import CanvasFlowStoreProbe from './CanvasFlowStoreProbe.svelte';
	let {
		session,
		editing = true,
		selectedIds = new Set<string>(),
		onselect = () => {},
		onstore,
	}: {
		session: CanvasSession;
		editing?: boolean;
		selectedIds?: ReadonlySet<string>;
		onselect?: (ids: ReadonlySet<string>) => void;
		onstore?: (store: ReturnType<typeof useStore<CanvasFlowNode>>) => void;
	} = $props();
	const controller = new CanvasController(recoveryMemory().port);
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
		{selectedIds}
		{editing}
		presentation="window-main"
		{onselect}
		onerror={(message) => {
			throw new Error(message);
		}}
	/>
	{#if onstore}<CanvasFlowStoreProbe {onstore} />{/if}
</SvelteFlowProvider>
