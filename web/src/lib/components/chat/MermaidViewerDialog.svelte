<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
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
	let activePointerId: number | null = null;

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

	function resetView() {
		zoom = 1;
		viewportElement?.scrollTo({ left: 0, top: 0 });
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) {
			resetView();
			finishDragging();
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
			resetView();
		}
	}

	function handleWheel(event: WheelEvent) {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		if (event.deltaY < 0) zoomIn();
		else if (event.deltaY > 0) zoomOut();
	}

	function handlePointerDown(event: PointerEvent) {
		if (
			event.button !== 0 ||
			event.isPrimary === false ||
			activePointerId !== null ||
			!viewportElement
		) {
			return;
		}
		activePointerId = event.pointerId;
		dragging = true;
		dragOriginX = event.clientX;
		dragOriginY = event.clientY;
		scrollOriginLeft = viewportElement.scrollLeft;
		scrollOriginTop = viewportElement.scrollTop;
		viewportElement.setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (activePointerId !== event.pointerId || !viewportElement) return;
		viewportElement.scrollLeft = scrollOriginLeft - (event.clientX - dragOriginX);
		viewportElement.scrollTop = scrollOriginTop - (event.clientY - dragOriginY);
	}

	function finishDragging(pointerId: number | null = activePointerId, releaseCapture = true) {
		if (activePointerId === null || pointerId !== activePointerId) return;
		const ownedPointerId = activePointerId;
		activePointerId = null;
		dragging = false;
		if (releaseCapture && viewportElement?.hasPointerCapture(ownedPointerId)) {
			viewportElement.releasePointerCapture(ownedPointerId);
		}
	}

	function stopDragging(event: PointerEvent) {
		finishDragging(event.pointerId);
	}

	function handleLostPointerCapture(event: PointerEvent) {
		finishDragging(event.pointerId, false);
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content
		class="flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
		showCloseButton={false}
		onkeydown={handleKeydown}
	>
		<header
			class="flex min-h-12 min-w-0 shrink-0 items-center gap-1 border-b border-border px-2 sm:gap-3 sm:px-4"
		>
			<Dialog.Title class="min-w-0 flex-1 truncate text-base">
				{m.chat_mermaid_viewer_title()}
			</Dialog.Title>
			<Dialog.Description class="sr-only">
				{m.chat_mermaid_viewer_description()}
			</Dialog.Description>
			<div class="flex shrink-0 items-center gap-0 sm:gap-1">
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
					onclick={resetView}
					title={m.chat_mermaid_viewer_reset()}
					aria-label={m.chat_mermaid_viewer_reset()}
				>
					<RotateCcw />
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

		<!-- svelte-ignore a11y_no_noninteractive_tabindex -- overflow-auto makes this region keyboard-scrollable; follow-up: sveltejs/svelte#11885 -->
		<div
			bind:this={viewportElement}
			class:cursor-grabbing={dragging}
			class:cursor-grab={!dragging}
			class="mermaid-viewport min-h-0 flex-1 touch-none select-none overflow-auto bg-muted/30 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6"
			role="region"
			aria-label={m.chat_mermaid_viewer_viewport()}
			tabindex="0"
			onwheel={handleWheel}
			onpointerdown={handlePointerDown}
			onpointermove={handlePointerMove}
			onpointerup={stopDragging}
			onpointercancel={stopDragging}
			onlostpointercapture={handleLostPointerCapture}
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
