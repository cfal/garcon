<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import type { SplitDirection } from '$lib/workspace/surface-types.js';
	import { clampSplitRatio } from '$lib/workspace/pane-tree.js';
	import * as m from '$lib/paraglide/messages.js';

	// Pixel step applied per arrow-key press when resizing via keyboard.
	const KEYBOARD_RESIZE_STEP = 24;

	interface WorkspacePaneResizerProps {
		direction: SplitDirection;
		ratio: number;
		style: string;
		// Fraction of the host region this split spans on its axis, used to
		// convert pointer pixels into ratio deltas for nested splits.
		boundsFraction: number;
		onPreview: (ratio: number | null) => void;
		onCommit: (ratio: number) => void;
		onReset: () => void;
	}

	let { direction, ratio, style, boundsFraction, onPreview, onCommit, onReset }: WorkspacePaneResizerProps =
		$props();

	let isDragging = $state(false);
	let trackElement: HTMLDivElement | null = $state(null);

	const isHorizontal = $derived(direction === 'horizontal');

	function containerSize(): number {
		const container = trackElement?.parentElement;
		if (!container) return 0;
		const rect = container.getBoundingClientRect();
		return (isHorizontal ? rect.width : rect.height) * boundsFraction;
	}

	function handlePointerDown(e: PointerEvent) {
		e.preventDefault();
		isDragging = true;
		const startPos = isHorizontal ? e.clientX : e.clientY;
		const startRatio = ratio;
		const size = containerSize();
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture?.(e.pointerId);

		document.body.style.userSelect = 'none';
		document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';

		let previewRatio = startRatio;
		function handlePointerMove(ev: PointerEvent) {
			ev.preventDefault();
			if (size <= 0) return;
			const currentPos = isHorizontal ? ev.clientX : ev.clientY;
			previewRatio = clampSplitRatio(startRatio + (currentPos - startPos) / size);
			onPreview(previewRatio);
		}

		function handlePointerUp(ev: PointerEvent) {
			isDragging = false;
			document.body.style.userSelect = '';
			document.body.style.cursor = '';
			document.removeEventListener('pointermove', handlePointerMove);
			document.removeEventListener('pointerup', handlePointerUp);
			document.removeEventListener('pointercancel', handlePointerUp);
			if (target.hasPointerCapture?.(ev.pointerId)) {
				target.releasePointerCapture(ev.pointerId);
			}
			onPreview(null);
			if (previewRatio !== startRatio) onCommit(previewRatio);
		}

		document.addEventListener('pointermove', handlePointerMove);
		document.addEventListener('pointerup', handlePointerUp);
		document.addEventListener('pointercancel', handlePointerUp);
	}

	// Each key press is an independent preview+commit pair so held keys
	// re-measure the container between steps.
	function handleKeyDown(e: KeyboardEvent) {
		const decreaseKey = isHorizontal ? 'ArrowLeft' : 'ArrowUp';
		const increaseKey = isHorizontal ? 'ArrowRight' : 'ArrowDown';
		if (e.key !== decreaseKey && e.key !== increaseKey) return;
		e.preventDefault();
		const size = containerSize();
		if (size <= 0) return;
		const delta = (e.key === increaseKey ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP) / size;
		onCommit(clampSplitRatio(ratio + delta));
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI-ARIA window splitter is a focusable separator resized via arrow keys; follow-up: CLEANUP_ROUND_TWO.md#a11y-suppression-register -->
<div
	bind:this={trackElement}
	class={cn(
		'absolute flex-shrink-0 group select-none touch-none z-10 outline-none',
		'focus-visible:ring-2 focus-visible:ring-ring rounded-full',
		isHorizontal ? 'cursor-col-resize' : 'cursor-row-resize',
	)}
	{style}
	onpointerdown={handlePointerDown}
	ondblclick={onReset}
	onkeydown={handleKeyDown}
	role="separator"
	aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
	aria-label={m.layout_resize_panes()}
	tabindex="0"
>
	<!-- Wide invisible hit area for easy grabbing -->
	<div
		class={cn('absolute z-10', isHorizontal ? 'inset-y-0 -left-5 w-11' : 'inset-x-0 -top-5 h-11')}
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
