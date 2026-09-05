<script lang="ts">
	import { onDestroy } from 'svelte';
	import { cn } from '$lib/utils/cn';
	import {
		MAX_PARTITION_RATIO,
		MIN_PARTITION_RATIO,
		type WorkspacePartitionDirection,
	} from '$lib/workspace/surface-types.js';
	import { clampPartitionRatio } from '$lib/workspace/window-tree.js';
	import * as m from '$lib/paraglide/messages.js';

	// Pixel step applied per arrow-key press when resizing via keyboard.
	const KEYBOARD_RESIZE_STEP = 24;

	interface WorkspaceWindowResizerProps {
		direction: WorkspacePartitionDirection;
		ratio: number;
		style: string;
		// Fraction of the host region this partition spans on its axis, used to
		// convert pointer pixels into a ratio delta for nested partitions.
		boundsFraction: number;
		onPreview: (ratio: number | null) => void;
		onCommit: (ratio: number) => void;
		onReset: () => void;
	}

	let {
		direction,
		ratio,
		style,
		boundsFraction,
		onPreview,
		onCommit,
		onReset,
	}: WorkspaceWindowResizerProps = $props();

	let isDragging = $state(false);
	let previewRatio = $state<number | null>(null);
	let trackElement: HTMLDivElement | null = $state(null);
	let pointerCleanup: (() => void) | null = null;

	const isHorizontal = $derived(direction === 'horizontal');

	function containerSize(): number {
		const container = trackElement?.parentElement;
		if (!container) return 0;
		const rect = container.getBoundingClientRect();
		return (isHorizontal ? rect.width : rect.height) * boundsFraction;
	}

	function handlePointerDown(e: PointerEvent): void {
		if (e.button !== 0 || !e.isPrimary || pointerCleanup) return;
		e.preventDefault();
		isDragging = true;
		const startPos = isHorizontal ? e.clientX : e.clientY;
		const startRatio = ratio;
		const size = containerSize();
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture?.(e.pointerId);
		const previousUserSelect = document.body.style.userSelect;
		const previousCursor = document.body.style.cursor;

		document.body.style.userSelect = 'none';
		document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';

		function handlePointerMove(ev: PointerEvent): void {
			if (ev.pointerId !== e.pointerId) return;
			ev.preventDefault();
			if (size <= 0) return;
			const currentPos = isHorizontal ? ev.clientX : ev.clientY;
			previewRatio = clampPartitionRatio(startRatio + (currentPos - startPos) / size);
			onPreview(previewRatio);
		}

		function finish(commit: boolean, ev?: PointerEvent): void {
			if (ev && ev.pointerId !== e.pointerId) return;
			const committedRatio = previewRatio;
			pointerCleanup = null;
			isDragging = false;
			document.body.style.userSelect = previousUserSelect;
			document.body.style.cursor = previousCursor;
			document.removeEventListener('pointermove', handlePointerMove);
			document.removeEventListener('pointerup', handlePointerUp);
			document.removeEventListener('pointercancel', handlePointerCancel);
			if (target.hasPointerCapture?.(e.pointerId)) {
				target.releasePointerCapture(e.pointerId);
			}
			previewRatio = null;
			onPreview(null);
			if (commit && committedRatio !== null && committedRatio !== startRatio) {
				onCommit(committedRatio);
			}
		}

		function handlePointerUp(ev: PointerEvent): void {
			finish(true, ev);
		}

		function handlePointerCancel(ev: PointerEvent): void {
			finish(false, ev);
		}

		document.addEventListener('pointermove', handlePointerMove);
		document.addEventListener('pointerup', handlePointerUp);
		document.addEventListener('pointercancel', handlePointerCancel);
		pointerCleanup = () => finish(false);
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
		onCommit(clampPartitionRatio(ratio + delta));
	}

	onDestroy(() => pointerCleanup?.());
</script>

<!-- The WAI-ARIA window partition is a focusable separator resized via arrow keys. Follow-up: CLEANUP_ROUND_TWO.md#a11y-suppression-register. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	bind:this={trackElement}
	class={cn(
		'pointer-events-none absolute z-40 flex-shrink-0 select-none touch-none outline-none group',
		'focus-visible:ring-2 focus-visible:ring-ring rounded-full',
		isHorizontal ? 'cursor-col-resize' : 'cursor-row-resize',
	)}
	{style}
	onpointerdown={handlePointerDown}
	ondblclick={onReset}
	onkeydown={handleKeyDown}
	role="separator"
	aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
	aria-label={m.layout_resize_windows()}
	aria-valuemin={Math.round(MIN_PARTITION_RATIO * 100)}
	aria-valuemax={Math.round(MAX_PARTITION_RATIO * 100)}
	aria-valuenow={Math.round((previewRatio ?? ratio) * 100)}
	tabindex="0"
>
	<div
		data-workspace-window-separator-line
		class={cn(
			'pointer-events-none absolute bg-border',
			isHorizontal
				? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
				: 'inset-x-0 top-1/2 h-px -translate-y-1/2',
		)}
	></div>
	<!-- The vertical target stays inside the content gutters reserved by adjacent windows. -->
	<div
		data-workspace-window-resize-hit-area
		class={cn(
			'pointer-events-auto absolute z-10',
			isHorizontal ? '-left-2.5 bottom-0 top-10 w-6' : 'inset-x-0 bottom-0 h-6',
		)}
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
			{#each [0, 1, 2] as _, index (index)}
				<div class="w-0.5 h-0.5 rounded-full bg-primary/50"></div>
			{/each}
		</div>
	</div>
</div>
