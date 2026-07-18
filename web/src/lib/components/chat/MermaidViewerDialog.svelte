<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import Maximize from '@lucide/svelte/icons/maximize';
	import X from '@lucide/svelte/icons/x';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import ZoomOut from '@lucide/svelte/icons/zoom-out';

	interface Props {
		open: boolean;
		svg: string;
		onOpenChange: (open: boolean) => void;
	}

	let { open, svg, onOpenChange }: Props = $props();

	const ZOOM_STEP = 0.25;
	const ZOOM_MIN = 0.25;
	const ZOOM_MAX = 4;

	let zoom = $state(1);
	let viewportElement = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);
	let dragOriginX = 0;
	let dragOriginY = 0;
	let scrollOriginLeft = 0;
	let scrollOriginTop = 0;

	const zoomPercent = $derived(Math.round(zoom * 100));

	function setZoom(nextZoom: number) {
		zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextZoom));
	}

	function zoomIn() {
		setZoom(zoom + ZOOM_STEP);
	}

	function zoomOut() {
		setZoom(zoom - ZOOM_STEP);
	}

	function fitToWindow() {
		zoom = 1;
		viewportElement?.scrollTo({ left: 0, top: 0 });
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) {
			fitToWindow();
			dragging = false;
		}
		onOpenChange(nextOpen);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === '+' || event.key === '=') {
			event.preventDefault();
			zoomIn();
		} else if (event.key === '-') {
			event.preventDefault();
			zoomOut();
		} else if (event.key === '0') {
			event.preventDefault();
			fitToWindow();
		}
	}

	function handleWheel(event: WheelEvent) {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		if (event.deltaY < 0) zoomIn();
		else if (event.deltaY > 0) zoomOut();
	}

	function handlePointerDown(event: PointerEvent) {
		if (event.button !== 0 || !viewportElement) return;
		dragging = true;
		dragOriginX = event.clientX;
		dragOriginY = event.clientY;
		scrollOriginLeft = viewportElement.scrollLeft;
		scrollOriginTop = viewportElement.scrollTop;
		viewportElement.setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!dragging || !viewportElement) return;
		viewportElement.scrollLeft = scrollOriginLeft - (event.clientX - dragOriginX);
		viewportElement.scrollTop = scrollOriginTop - (event.clientY - dragOriginY);
	}

	function stopDragging(event: PointerEvent) {
		if (!dragging || !viewportElement) return;
		dragging = false;
		if (viewportElement.hasPointerCapture(event.pointerId)) {
			viewportElement.releasePointerCapture(event.pointerId);
		}
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
		showCloseButton={false}
		onkeydown={handleKeydown}
	>
		<header class="flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-4">
			<Dialog.Title class="mr-auto truncate text-base">Mermaid diagram</Dialog.Title>
			<Dialog.Description class="sr-only">
				Expanded Mermaid diagram with zoom and pan controls
			</Dialog.Description>
			<div class="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={zoomOut}
					disabled={zoom <= ZOOM_MIN}
					title={m.image_zoom_out()}
					aria-label={m.image_zoom_out()}
				>
					<ZoomOut />
				</Button>
				<span
					class="w-12 text-center text-xs tabular-nums text-muted-foreground"
					aria-live="polite"
				>
					{zoomPercent}%
				</span>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={zoomIn}
					disabled={zoom >= ZOOM_MAX}
					title={m.image_zoom_in()}
					aria-label={m.image_zoom_in()}
				>
					<ZoomIn />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={fitToWindow}
					title={m.image_fit_to_window()}
					aria-label={m.image_fit_to_window()}
				>
					<Maximize />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={() => handleOpenChange(false)}
					title={m.image_close()}
					aria-label={m.image_close()}
				>
					<X />
				</Button>
			</div>
		</header>

		<div
			bind:this={viewportElement}
			class:cursor-grabbing={dragging}
			class:cursor-grab={!dragging}
			class="mermaid-viewport min-h-0 flex-1 touch-none select-none overflow-auto bg-muted/30 p-4 sm:p-6"
			role="region"
			aria-label="Mermaid diagram viewport; drag to pan"
			onwheel={handleWheel}
			onpointerdown={handlePointerDown}
			onpointermove={handlePointerMove}
			onpointerup={stopDragging}
			onpointercancel={stopDragging}
		>
			<div class="mermaid-zoom-stage mx-auto" style:width={`${zoomPercent}%`}>
				{@html svg}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	.mermaid-zoom-stage :global(svg) {
		display: block;
		width: 100%;
		max-width: none !important;
		height: auto;
	}
</style>
