<script lang="ts">
	import type { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte.js';
	import type { ChatSessionRecord } from '$lib/types/chat-session.js';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';
	import CanvasPanel from './CanvasPanel.svelte';

	let {
		controller,
		chats,
		visible,
		presentation,
	}: {
		controller: CanvasController;
		chats: readonly ChatSessionRecord[];
		visible: boolean;
		presentation: PresentationHostId;
	} = $props();
</script>

<div class="h-full min-h-0" style:display={visible ? undefined : 'none'}>
	<CanvasPanel {controller} {chats} {visible} {presentation} />
</div>
