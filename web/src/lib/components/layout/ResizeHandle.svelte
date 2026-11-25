<script lang="ts">
	import { onDestroy } from 'svelte';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import type { DesktopLayoutEdge } from '$lib/layout/desktop-layout.js';

	interface ResizeHandleProps {
		width: number;
		edge?: DesktopLayoutEdge;
		onPreview: (width: number | null) => void;
		onCommit: (width: number) => void;
	}

	let { width, edge = 'end', onPreview, onCommit }: ResizeHandleProps = $props();

	let isDragging = $state(false);
	let cancelDrag: (() => void) | undefined;

	const MIN_WIDTH = 240;
	const MAX_WIDTH = 560;
	const KEYBOARD_STEP = 24;

	function clampWidth(value: number): number {
		return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));
	}

	function resizeDirection(target: HTMLElement): number {
		return (getComputedStyle(target).direction === 'rtl' ? -1 : 1) * (edge === 'start' ? -1 : 1);
	}

	function handlePointerDown(e: PointerEvent) {
		if (e.button !== 0 || !e.isPrimary || cancelDrag) return;
		e.preventDefault();
		isDragging = true;
		const startX = e.clientX;
		const startWidth = width;
		const target = e.currentTarget as HTMLElement;
		const direction = resizeDirection(target);
		target.setPointerCapture?.(e.pointerId);
		let preview = startWidth;

		function handlePointerMove(ev: PointerEvent) {
			if (ev.pointerId !== e.pointerId) return;
			const next = clampWidth(startWidth + (ev.clientX - startX) * direction);
			if (next === preview) return;
			preview = next;
			onPreview(preview);
		}

		function finish(commit: boolean) {
			cancelDrag = undefined;
			isDragging = false;
			target.removeEventListener('pointermove', handlePointerMove);
			target.removeEventListener('pointerup', handlePointerUp);
			target.removeEventListener('pointercancel', handlePointerCancel);
			target.removeEventListener('lostpointercapture', handlePointerCancel);
			if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
			if (commit && preview !== startWidth) onCommit(preview);
			onPreview(null);
		}

		function handlePointerUp(ev: PointerEvent) {
			if (ev.pointerId === e.pointerId) finish(true);
		}

		function handlePointerCancel(ev: PointerEvent) {
			if (ev.pointerId === e.pointerId) finish(false);
		}

		cancelDrag = () => finish(false);
		target.addEventListener('pointermove', handlePointerMove);
		target.addEventListener('pointerup', handlePointerUp);
		target.addEventListener('pointercancel', handlePointerCancel);
		target.addEventListener('lostpointercapture', handlePointerCancel);
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		if (cancelDrag) return;
		const direction = resizeDirection(e.currentTarget as HTMLElement);
		const next = clampWidth(width + (e.key === 'ArrowRight' ? 1 : -1) * KEYBOARD_STEP * direction);
		if (next !== width) onCommit(next);
	}

	onDestroy(() => cancelDrag?.());

	let indicatorClass = $derived(
		cn(
			'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150',
			isDragging ? 'bg-primary/30' : 'group-hover:bg-primary/20',
		),
	);
</script>

<div
	class={cn(
		'pointer-events-none absolute inset-y-0 z-10 w-0',
		edge === 'start' ? 'start-0' : 'end-0',
	)}
>
	<!-- The focusable WAI-ARIA separator supports arrow-key resize. Covered by __tests__/ResizeHandle.test.ts. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		class="absolute inset-y-0 -left-2 w-4 cursor-col-resize group select-none touch-none pointer-events-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
		onpointerdown={handlePointerDown}
		onkeydown={handleKeyDown}
		role="separator"
		data-layout-resizer
		aria-orientation="vertical"
		aria-label={m.layout_resize_sidebar()}
		aria-valuemin={MIN_WIDTH}
		aria-valuemax={MAX_WIDTH}
		aria-valuenow={width}
		tabindex="0"
	>
		<div class={indicatorClass}></div>
	</div>
</div>
