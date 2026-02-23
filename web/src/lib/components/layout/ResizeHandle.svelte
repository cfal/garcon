<script lang="ts">
	import { cn } from '$lib/utils/cn';

	interface ResizeHandleProps {
		width: number;
		onResize: (width: number) => void;
	}

	let { width, onResize }: ResizeHandleProps = $props();

	let isDragging = $state(false);

	const MIN_WIDTH = 240;
	const MAX_WIDTH = 560;

	function handlePointerDown(e: PointerEvent) {
		isDragging = true;
		const startX = e.clientX;
		const startWidth = width;
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);

		function handlePointerMove(ev: PointerEvent) {
			const delta = ev.clientX - startX;
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

let indicatorClass = $derived(cn(
		'absolute inset-y-0 left-0 w-px transition-colors duration-150',
		isDragging ? 'bg-primary/30' : 'group-hover:bg-primary/20',
	));
</script>

<div
	class="absolute inset-y-0 right-0 w-0 pointer-events-none z-10"
>
	<div
		class={cn(
			'absolute inset-y-0 -left-2 w-4 cursor-col-resize group select-none touch-none pointer-events-auto',
			isDragging && 'bg-primary/10',
		)}
		onpointerdown={handlePointerDown}
		role="separator"
		aria-orientation="vertical"
		aria-label="Resize sidebar"
		tabindex="-1"
	>
		<div class={indicatorClass}></div>
	</div>
</div>
