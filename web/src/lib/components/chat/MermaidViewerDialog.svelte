<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import {
		calculateFitScale,
		captureZoomAnchor,
		clampZoomScale,
		distance,
		midpoint,
		restoreZoomAnchor,
		type ZoomAnchor,
		type ZoomPoint,
		type ZoomSize,
	} from '$lib/components/shared/zoom-viewport.js';
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
	const ZOOM_MIN = 0.05;
	const ZOOM_MAX = 5;
	const FIT_ZOOM_MIN = 0;
	const VIEWPORT_PADDING = 24;

	let zoom = $state(1);
	let gestureZoomMin = $state(ZOOM_MIN);
	let viewportElement = $state<HTMLDivElement | null>(null);
	let stageElement = $state<HTMLDivElement | null>(null);
	let viewportSize = $state<ZoomSize>({ width: 1, height: 1 });
	let contentSize = $state<ZoomSize>({ width: 1, height: 1 });
	let viewMode = $state<'fit' | 'manual'>('fit');
	let dragging = $state(false);
	let pinching = $state(false);
	let dragOriginX = 0;
	let dragOriginY = 0;
	let scrollOriginLeft = 0;
	let scrollOriginTop = 0;
	let panPointerId: number | null = null;
	let zoomFrame: number | null = null;
	let pendingZoomAnchor: ZoomAnchor | null = null;
	const pointers = new Map<number, ZoomPoint>();
	let pinchGesture: {
		pointerIds: [number, number];
		initialDistance: number;
		initialZoom: number;
		focal: ZoomPoint;
	} | null = null;

	const zoomPercent = $derived(Math.round(zoom * 100));
	const zoomLabel = $derived(zoom > 0 && zoom < 0.01 ? '<1%' : `${zoomPercent}%`);
	const stageWidth = $derived(contentSize.width * zoom);
	const stageHeight = $derived(contentSize.height * zoom);
	const canvasWidth = $derived(Math.max(viewportSize.width, stageWidth + VIEWPORT_PADDING * 2));
	const canvasHeight = $derived(Math.max(viewportSize.height, stageHeight + VIEWPORT_PADDING * 2));
	const stageLeft = $derived((canvasWidth - stageWidth) / 2);
	const stageTop = $derived((canvasHeight - stageHeight) / 2);
	const canPan = $derived(canvasWidth > viewportSize.width || canvasHeight > viewportSize.height);

	function readContentSize(): ZoomSize {
		const renderedSvg = stageElement?.querySelector('svg');
		const viewBox = renderedSvg
			?.getAttribute('viewBox')
			?.trim()
			.split(/[\s,]+/)
			.map(Number);
		if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
			return { width: viewBox[2], height: viewBox[3] };
		}
		const rect = renderedSvg?.getBoundingClientRect();
		return {
			width: Math.max(1, rect?.width ?? 1),
			height: Math.max(1, rect?.height ?? 1),
		};
	}

	function updateGeometry() {
		if (!viewportElement) return;
		viewportSize = {
			width: Math.max(1, viewportElement.clientWidth),
			height: Math.max(1, viewportElement.clientHeight),
		};
		contentSize = readContentSize();
	}

	function captureCurrentAnchor(client?: ZoomPoint): ZoomAnchor | null {
		if (!viewportElement || !stageElement) return null;
		return captureZoomAnchor(
			viewportElement.getBoundingClientRect(),
			stageElement.getBoundingClientRect(),
			client,
		);
	}

	function restoreScheduledAnchor() {
		if (zoomFrame !== null) cancelAnimationFrame(zoomFrame);
		zoomFrame = null;
		const anchor = pendingZoomAnchor;
		pendingZoomAnchor = null;
		if (!anchor || !viewportElement || !stageElement) return;
		restoreZoomAnchor(viewportElement, stageElement.getBoundingClientRect(), anchor);
	}

	function cancelAnchorRestore() {
		if (zoomFrame !== null) cancelAnimationFrame(zoomFrame);
		zoomFrame = null;
		pendingZoomAnchor = null;
	}

	function scheduleAnchorRestore(anchor: ZoomAnchor | null) {
		if (!anchor) return;
		pendingZoomAnchor = pendingZoomAnchor
			? { client: anchor.client, focal: pendingZoomAnchor.focal }
			: anchor;
		if (zoomFrame !== null) return;
		zoomFrame = requestAnimationFrame(() => {
			zoomFrame = null;
			const scheduledAnchor = pendingZoomAnchor;
			pendingZoomAnchor = null;
			if (!scheduledAnchor || !viewportElement || !stageElement) return;
			restoreZoomAnchor(viewportElement, stageElement.getBoundingClientRect(), scheduledAnchor);
		});
	}

	function setZoom(nextZoom: number, client?: ZoomPoint) {
		const clampedZoom = clampZoomScale(nextZoom, gestureZoomMin, ZOOM_MAX);
		if (clampedZoom === zoom) return;
		const anchor = captureCurrentAnchor(client);
		viewMode = 'manual';
		zoom = clampedZoom;
		scheduleAnchorRestore(anchor);
	}

	function zoomIn() {
		setZoom(zoom + ZOOM_STEP);
	}

	function zoomOut() {
		setZoom(zoom - ZOOM_STEP);
	}

	function fitToWindow() {
		updateGeometry();
		viewMode = 'fit';
		zoom = calculateFitScale({
			viewport: viewportSize,
			content: contentSize,
			padding: VIEWPORT_PADDING,
			minScale: FIT_ZOOM_MIN,
			maxScale: ZOOM_MAX,
		});
		gestureZoomMin = Math.min(ZOOM_MIN, zoom);
		cancelAnchorRestore();
		zoomFrame = requestAnimationFrame(() => {
			zoomFrame = null;
			if (!viewportElement) return;
			viewportElement.scrollTo({
				left: Math.max(0, (viewportElement.scrollWidth - viewportElement.clientWidth) / 2),
				top: Math.max(0, (viewportElement.scrollHeight - viewportElement.clientHeight) / 2),
			});
		});
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) {
			cancelAnchorRestore();
			viewMode = 'fit';
			zoom = 1;
			gestureZoomMin = ZOOM_MIN;
			clearPointers();
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
		setZoom(zoom * Math.exp(-event.deltaY * 0.002), {
			x: event.clientX,
			y: event.clientY,
		});
	}

	function handlePointerDown(event: PointerEvent) {
		if (!viewportElement || (event.pointerType === 'mouse' && event.button !== 0)) return;
		if (pointers.size === 0 && pendingZoomAnchor) restoreScheduledAnchor();
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		viewportElement.setPointerCapture(event.pointerId);
		if (pointers.size === 2) {
			startPinch();
			return;
		}
		if (pointers.size > 2) return;
		startPan(event.pointerId, { x: event.clientX, y: event.clientY });
	}

	function startPan(pointerId: number, point: ZoomPoint) {
		panPointerId = pointerId;
		dragging = canPan;
		dragOriginX = point.x;
		dragOriginY = point.y;
		scrollOriginLeft = viewportElement?.scrollLeft ?? 0;
		scrollOriginTop = viewportElement?.scrollTop ?? 0;
	}

	function startPinch() {
		const pointerIds = [...pointers.keys()].slice(0, 2) as [number, number];
		const first = pointers.get(pointerIds[0]);
		const second = pointers.get(pointerIds[1]);
		if (!first || !second) return;
		const anchor = captureCurrentAnchor(midpoint(first, second));
		if (!anchor) return;
		pinchGesture = {
			pointerIds,
			initialDistance: Math.max(1, distance(first, second)),
			initialZoom: zoom,
			focal: anchor.focal,
		};
		panPointerId = null;
		dragging = false;
		pinching = true;
	}

	function handlePointerMove(event: PointerEvent) {
		if (!pointers.has(event.pointerId) || !viewportElement) return;
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pinchGesture) {
			const first = pointers.get(pinchGesture.pointerIds[0]);
			const second = pointers.get(pinchGesture.pointerIds[1]);
			if (!first || !second) return;
			viewMode = 'manual';
			zoom = clampZoomScale(
				pinchGesture.initialZoom * (distance(first, second) / pinchGesture.initialDistance),
				gestureZoomMin,
				ZOOM_MAX,
			);
			scheduleAnchorRestore({
				client: midpoint(first, second),
				focal: pinchGesture.focal,
			});
			return;
		}
		if (panPointerId !== event.pointerId || !dragging) return;
		viewportElement.scrollLeft = scrollOriginLeft - (event.clientX - dragOriginX);
		viewportElement.scrollTop = scrollOriginTop - (event.clientY - dragOriginY);
	}

	function removePointer(pointerId: number, releaseCapture: boolean) {
		if (!pointers.has(pointerId)) return;
		pointers.delete(pointerId);
		if (releaseCapture && viewportElement?.hasPointerCapture(pointerId)) {
			viewportElement.releasePointerCapture(pointerId);
		}
		if (pinchGesture?.pointerIds.includes(pointerId)) {
			pinchGesture = null;
			pinching = false;
			if (pointers.size >= 2) {
				restoreScheduledAnchor();
				startPinch();
				return;
			}
			const remaining = pointers.entries().next().value as [number, ZoomPoint] | undefined;
			if (remaining) {
				restoreScheduledAnchor();
				startPan(remaining[0], remaining[1]);
			} else panPointerId = null;
		} else if (panPointerId === pointerId) {
			panPointerId = null;
			dragging = false;
		}
	}

	function stopDragging(event: PointerEvent) {
		removePointer(event.pointerId, true);
	}

	function handleLostPointerCapture(event: PointerEvent) {
		removePointer(event.pointerId, false);
	}

	function clearPointers() {
		const ownedPointerIds = [...pointers.keys()];
		pointers.clear();
		panPointerId = null;
		pinchGesture = null;
		dragging = false;
		pinching = false;
		for (const pointerId of ownedPointerIds) {
			if (viewportElement?.hasPointerCapture(pointerId)) {
				viewportElement.releasePointerCapture(pointerId);
			}
		}
	}

	$effect(() => {
		if (!open || !viewportElement || !stageElement) return;
		void svg;
		const viewport = viewportElement;
		let resizeFrame: number | null = null;
		const observer = new ResizeObserver(() => {
			if (resizeFrame !== null) return;
			resizeFrame = requestAnimationFrame(() => {
				resizeFrame = null;
				if (viewMode === 'fit') fitToWindow();
				else updateGeometry();
			});
		});
		observer.observe(viewport);
		const frame = requestAnimationFrame(fitToWindow);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
			cancelAnchorRestore();
			clearPointers();
		};
	});
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
					disabled={zoom <= gestureZoomMin}
					title={m.image_zoom_out()}
					aria-label={m.image_zoom_out()}
				>
					<ZoomOut />
				</Button>
				<span
					class="w-12 text-center text-xs tabular-nums text-muted-foreground"
					aria-live="polite"
				>
					{zoomLabel}
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

		<!-- svelte-ignore a11y_no_noninteractive_tabindex -- overflow-auto makes this region keyboard-scrollable; follow-up: sveltejs/svelte#11885 -->
		<div
			bind:this={viewportElement}
			class:cursor-grabbing={dragging || pinching}
			class:cursor-grab={canPan && !dragging && !pinching}
			class="mermaid-viewport min-h-0 flex-1 touch-none select-none overflow-auto bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
			<div
				class="mermaid-canvas relative"
				style:width={`${canvasWidth}px`}
				style:height={`${canvasHeight}px`}
			>
				<div
					bind:this={stageElement}
					class="mermaid-zoom-stage absolute"
					style:left={`${stageLeft}px`}
					style:top={`${stageTop}px`}
					style:width={`${stageWidth}px`}
					style:height={`${stageHeight}px`}
				>
					{@html svg}
				</div>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	.mermaid-zoom-stage :global(svg) {
		display: block;
		width: 100%;
		max-width: none !important;
		height: 100%;
	}
</style>
