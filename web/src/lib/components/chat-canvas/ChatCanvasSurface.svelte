<script lang="ts">
	import type { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte.js';
	import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';
	import CanvasPanel from './CanvasPanel.svelte';

	let {
		controller,
		sessions,
		visible,
		presentation,
	}: {
		controller: CanvasController;
		sessions: Pick<ChatSessionsStore, 'byId' | 'orderedChats'>;
		visible: boolean;
		presentation: PresentationHostId;
	} = $props();
</script>

<div class="h-full min-h-0" style:display={visible ? undefined : 'none'}>
	<CanvasPanel {controller} {sessions} {visible} {presentation} />
</div>
