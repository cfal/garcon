<script lang="ts">
	import type { NodeProps } from '@xyflow/svelte';
	import type { CanvasFlowNode } from './canvas-node-types';
	import { getCanvasView } from '$lib/context/canvas-context';
	import * as m from '$lib/paraglide/messages.js';
	import CanvasHandles from './CanvasHandles.svelte';
	let { id, selected }: NodeProps<CanvasFlowNode> = $props();
	const view = getCanvasView();
	const box = $derived(view.document.content.nodes.find((node) => node.id === id));
	const count = $derived(
		view.document.content.nodes.filter((node) => node.type === 'chat' && node.boxId === id).length,
	);
</script>

<div
	class="canvas-box h-full w-full rounded-xl border-2 bg-muted/35"
	class:canvas-selected={selected}
	data-canvas-box={id}
>
	<div
		class="canvas-drag-handle flex h-[52px] items-center justify-between gap-2 border-b border-border px-4"
	>
		<span class="truncate text-sm font-semibold">{box?.type === 'box' ? box.title : ''}</span>
		<span class="shrink-0 text-xs text-muted-foreground">{count}</span>
	</div>
	{#if count === 0}<p
			class="pointer-events-none px-4 py-8 text-center text-sm text-muted-foreground"
		>
			{m.canvas_empty_box()}
		</p>{/if}
	<CanvasHandles enabled={!view.readOnly} />
</div>
