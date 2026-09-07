<script module lang="ts">
	import { lazyRenderer } from '$lib/utils/lazy-renderer';
	const canvasRenderer = lazyRenderer(() => import('../chat-canvas/CanvasPanel.svelte'));
</script>

<script lang="ts">
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { PresentationHostId } from '$lib/workspace/surface-types';
	import type { ChatMapController } from '$lib/chat-map/chat-map-controller.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import ChatMapPanel from './ChatMapPanel.svelte';
	import '../chat-canvas/canvas.css';

	let {
		controller,
		chats,
		selectedChatId,
		visible,
		presentation,
	}: {
		controller: ChatMapController;
		chats: readonly ChatSessionRecord[];
		selectedChatId: string | null;
		visible: boolean;
		presentation: PresentationHostId;
	} = $props();
</script>

<div class="flex h-full min-h-0 flex-col" style:display={visible ? undefined : 'none'}>
	<nav
		class="flex shrink-0 gap-1 border-b border-border bg-card p-2"
		aria-label={m.canvas_navigation()}
	>
		<button
			type="button"
			class="canvas-button"
			aria-pressed={controller.mode === 'lineage'}
			onclick={() => (controller.mode = 'lineage')}>{m.canvas_lineage()}</button
		>
		<button
			type="button"
			class="canvas-button"
			aria-pressed={controller.mode === 'canvases'}
			onclick={() => (controller.mode = 'canvases')}>{m.canvas_canvases()}</button
		>
	</nav>
	<div class="min-h-0 flex-1">
		{#if controller.mode === 'lineage'}
			<ChatMapPanel {controller} {chats} {selectedChatId} {visible} {presentation} />
		{:else}
			{#await canvasRenderer() then CanvasPanel}
				<CanvasPanel controller={controller.canvases} {chats} {visible} {presentation} />
			{/await}
		{/if}
	</div>
</div>
