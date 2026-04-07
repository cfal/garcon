<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import type { SplitDirection } from '$lib/stores/split-layout.svelte';

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
		isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
		isDragging && 'bg-primary/20',
	)}
	onpointerdown={handlePointerDown}
	role="separator"
	aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
	aria-label="Resize panes"
	tabindex="-1"
>
	<!-- Wider hit area for easier grabbing -->
	<div
		class={cn(
			'absolute z-10',
			isHorizontal
				? 'inset-y-0 -left-1.5 w-4'
				: 'inset-x-0 -top-1.5 h-4',
		)}
	></div>
	<!-- Visual indicator line -->
	<div
		class={cn(
			'absolute transition-colors duration-100',
			isHorizontal
				? 'inset-y-0 left-0 w-px'
				: 'inset-x-0 top-0 h-px',
			isDragging
				? 'bg-primary/40'
				: 'bg-border group-hover:bg-primary/30',
		)}
	></div>
</div>
