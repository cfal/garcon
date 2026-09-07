<script lang="ts">
	import type { NodeProps } from '@xyflow/svelte';
	import type { CanvasFlowNode } from './canvas-node-types';
	import { getCanvasView } from '$lib/context/canvas-context';
	import * as m from '$lib/paraglide/messages.js';
	import CanvasChatCard from './CanvasChatCard.svelte';
	import CanvasHandles from './CanvasHandles.svelte';
	let { id, selected }: NodeProps<CanvasFlowNode> = $props();
	const view = getCanvasView();
	const placement = $derived(view.document.content.nodes.find((node) => node.id === id));
	const chat = $derived(placement?.type === 'chat' ? view.chats[placement.chatId] : undefined);
</script>

<div
	class="canvas-chat-node h-full w-full rounded-lg border bg-card shadow-sm"
	class:canvas-selected={selected}
>
	<div class="canvas-drag-handle h-[104px] overflow-hidden">
		<svelte:boundary>
			<CanvasChatCard {chat} currentTime={view.currentTime} />
			{#snippet failed()}<span class="text-xs text-destructive">{m.canvas_unavailable_chat()}</span
				>{/snippet}
		</svelte:boundary>
	</div>
	<div class="nodrag flex h-7 items-center justify-end border-t border-border px-2">
		{#if chat}<a
				class="canvas-link text-xs"
				href={`/chat/${chat.id}`}
				onclick={(event) => {
					event.stopPropagation();
					if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
						event.preventDefault();
						view.openChat(chat.id);
					}
				}}>{m.canvas_open_chat()}</a
			>{/if}
	</div>
	<CanvasHandles enabled={!view.readOnly} />
</div>
