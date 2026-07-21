<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import type { DesktopLayoutEdge } from '$lib/layout/desktop-layout.js';

	interface ResizeHandleProps {
		width: number;
		edge?: DesktopLayoutEdge;
		onResize: (width: number) => void;
	}

	let { width, edge = 'end', onResize }: ResizeHandleProps = $props();

	let isDragging = $state(false);

	const MIN_WIDTH = 240;
	const MAX_WIDTH = 560;

	function handlePointerDown(e: PointerEvent) {
		isDragging = true;
		const startX = e.clientX;
		const startWidth = width;
		const target = e.currentTarget as HTMLElement;
		const inlineDirection = getComputedStyle(target).direction === 'rtl' ? -1 : 1;
		target.setPointerCapture(e.pointerId);

		function handlePointerMove(ev: PointerEvent) {
			const edgeDirection = edge === 'start' ? -1 : 1;
			const delta = (ev.clientX - startX) * inlineDirection * edgeDirection;
			const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
			onResize(newWidth);
		}

		function handlePointerUp() {
			isDragging = false;
			target.removeEventListener('pointermove', handlePointerMove);
			target.removeEventListener('pointerup', handlePointerUp);
			target.removeEventListener('pointercancel', handlePointerUp);
		}

		target.addEventListener('pointermove', handlePointerMove);
		target.addEventListener('pointerup', handlePointerUp);
		target.addEventListener('pointercancel', handlePointerUp);
	}

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
	<div
		class={cn(
			'absolute inset-y-0 -left-2 w-4 cursor-col-resize group select-none touch-none pointer-events-auto',
			isDragging && 'bg-primary/10',
		)}
		onpointerdown={handlePointerDown}
		role="separator"
		aria-orientation="vertical"
		aria-label={m.layout_resize_sidebar()}
		tabindex="-1"
	>
		<div class={indicatorClass}></div>
	</div>
</div>
