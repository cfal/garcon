<script lang="ts">
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import type { CanvasSession } from '$lib/chat-canvas/canvas-session.svelte';
	import { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte';
	import { setCanvasView } from '$lib/context/canvas-context';
	import CanvasFlow from '../CanvasFlow.svelte';
	let { session }: { session: CanvasSession } = $props();
	const controller = new CanvasController();
	setCanvasView({
		get document() {
			return session.document;
		},
		chats: {},
		currentTime: new Date('2026-09-07T00:00:00Z'),
		readOnly: false,
		openChat: () => {},
	});
</script>

<SvelteFlowProvider>
	<CanvasFlow
		{session}
		{controller}
		selectedIds={new Set()}
		editing
		visible
		presentation="window-main"
		onselect={() => {}}
		onerror={(message) => {
			throw new Error(message);
		}}
	/>
</SvelteFlowProvider>
