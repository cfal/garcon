<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import type { SplitDirection } from '$lib/stores/split-layout.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface SplitResizerProps {
		direction: SplitDirection;
		onResize: (delta: number) => void;
	}

	let { direction, onResize }: SplitResizerProps = $props();

	let isDragging = $state(false);

	const isHorizontal = $derived(direction === 'horizontal');

	function handlePointerDown(e: PointerEvent) {
		isDragging = true;
		const startPos = isHorizontal ? e.clientX : e.clientY;
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);

		// Prevent text selection during drag.
		document.body.style.userSelect = 'none';
		document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';

		function handlePointerMove(ev: PointerEvent) {
			const currentPos = isHorizontal ? ev.clientX : ev.clientY;
			onResize(currentPos - startPos);
		}

		function handlePointerUp() {
			isDragging = false;
			document.body.style.userSelect = '';
			document.body.style.cursor = '';
			target.removeEventListener('pointermove', handlePointerMove);
			target.removeEventListener('pointerup', handlePointerUp);
			target.removeEventListener('pointercancel', handlePointerUp);
		}

		target.addEventListener('pointermove', handlePointerMove);
		target.addEventListener('pointerup', handlePointerUp);
		target.addEventListener('pointercancel', handlePointerUp);
	}
</script>

<div
	class={cn(
		'relative flex-shrink-0 group select-none touch-none z-10',
		isHorizontal ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize',
	)}
	onpointerdown={handlePointerDown}
	role="separator"
	aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
	aria-label={m.layout_resize_panes()}
	tabindex="-1"
>
	<!-- Wide invisible hit area for easy grabbing -->
	<div
		class={cn('absolute z-10', isHorizontal ? 'inset-y-0 -left-2 w-5' : 'inset-x-0 -top-2 h-5')}
	></div>
	<!-- Track background -->
	<div
		class={cn(
			'absolute rounded-full transition-all duration-150',
			isHorizontal ? 'inset-y-0 left-0 right-0' : 'inset-x-0 top-0 bottom-0',
			isDragging ? 'bg-primary/30' : 'bg-transparent group-hover:bg-primary/10',
		)}
	></div>
	<!-- Center grip dots (visible on hover/drag) -->
	<div
		class={cn(
			'absolute transition-opacity duration-150 flex items-center justify-center',
			isHorizontal ? 'inset-y-0 left-0 right-0' : 'inset-x-0 top-0 bottom-0',
			isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
		)}
	>
		<div class={cn('flex gap-0.5', isHorizontal ? 'flex-col' : 'flex-row')}>
			{#each [0, 1, 2] as _}
				<div class="w-0.5 h-0.5 rounded-full bg-primary/50"></div>
			{/each}
		</div>
	</div>
</div>
