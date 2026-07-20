<script lang="ts">
	import Maximize from '@lucide/svelte/icons/maximize';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import ZoomOut from '@lucide/svelte/icons/zoom-out';
	import { Button } from '$lib/components/ui/button';
	import {
		calculateFitScale,
		captureZoomAnchor,
		centerOfRect,
		restoreZoomAnchor,
		type ZoomAnchor,
		type ZoomPoint,
	} from '$lib/components/shared/zoom-viewport.js';
	import type { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let { session }: { session: FileSession } = $props();
	let imageElement: HTMLImageElement | null = $state(null);
	let viewportElement: HTMLDivElement | null = $state(null);

	const ZOOM_STEP = 0.25;
	const ZOOM_MIN = 0.25;
	const ZOOM_MAX = 5;
	let pendingZoomAnchor: ZoomAnchor | null = null;
	let zoomFrame: number | null = null;
	let scrollReleaseFrame: number | null = null;
	let correctingScroll = false;

	function cancelPendingManualZoom(): void {
		if (zoomFrame !== null) cancelAnimationFrame(zoomFrame);
		zoomFrame = null;
		pendingZoomAnchor = null;
	}

	function scheduleScrollRelease(): void {
		if (scrollReleaseFrame !== null) cancelAnimationFrame(scrollReleaseFrame);
		scrollReleaseFrame = requestAnimationFrame(() => {
			scrollReleaseFrame = null;
			correctingScroll = false;
		});
	}

	function setManualScale(scale: number, client?: ZoomPoint): void {
		const anchor = pendingZoomAnchor ?? captureViewport(client);
		session.image = {
			...session.image,
			mode: 'manual',
			scale: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale)),
			...(anchor ? { focalX: anchor.focal.x, focalY: anchor.focal.y } : {}),
		};
		if (!anchor) return;
		pendingZoomAnchor = anchor;
		if (zoomFrame !== null) return;
		zoomFrame = requestAnimationFrame(() => {
			zoomFrame = null;
			const immutableAnchor = pendingZoomAnchor;
			pendingZoomAnchor = null;
			if (immutableAnchor) restoreManualFocalPoint(immutableAnchor);
		});
	}

	function fitToWindow(): void {
		const image = imageElement;
		const viewport = viewportElement;
		if (!image || !viewport) return;
		cancelPendingManualZoom();
		const scale = calculateFitScale({
			viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
			content: { width: image.naturalWidth, height: image.naturalHeight },
			padding: 16,
			minScale: ZOOM_MIN,
			maxScale: ZOOM_MAX,
		});
		session.image = {
			...session.image,
			mode: 'fit',
			scale: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale)),
			focalX: 0.5,
			focalY: 0.5,
			scrollLeft: 0,
			scrollTop: 0,
		};
		correctingScroll = true;
		viewport.scrollLeft = 0;
		viewport.scrollTop = 0;
		scheduleScrollRelease();
	}

	function captureViewport(client?: ZoomPoint): ZoomAnchor | null {
		if (!viewportElement || !imageElement) return null;
		const viewportRect = viewportElement.getBoundingClientRect();
		const imageRect = imageElement.getBoundingClientRect();
		return captureZoomAnchor(viewportRect, imageRect, client ?? centerOfRect(viewportRect), {
			x: session.image.focalX,
			y: session.image.focalY,
		});
	}

	function persistViewport(): void {
		if (!viewportElement || correctingScroll) return;
		const anchor = captureViewport();
		if (!anchor) return;
		session.image = {
			...session.image,
			focalX: anchor.focal.x,
			focalY: anchor.focal.y,
			scrollLeft: viewportElement.scrollLeft,
			scrollTop: viewportElement.scrollTop,
		};
	}

	function restoreManualFocalPoint(anchor: ZoomAnchor): void {
		if (!viewportElement || !imageElement || session.image.mode !== 'manual') return;
		const imageRect = imageElement.getBoundingClientRect();
		correctingScroll = true;
		restoreZoomAnchor(viewportElement, imageRect, anchor);
		session.image = {
			...session.image,
			scrollLeft: viewportElement.scrollLeft,
			scrollTop: viewportElement.scrollTop,
		};
		scheduleScrollRelease();
	}

	function restoreSavedManualFocalPoint(): void {
		if (!viewportElement) return;
		restoreManualFocalPoint({
			client: centerOfRect(viewportElement.getBoundingClientRect()),
			focal: { x: session.image.focalX, y: session.image.focalY },
		});
	}

	function handleWheel(event: WheelEvent): void {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		const scale = session.image.scale * Math.exp(-event.deltaY * 0.002);
		setManualScale(scale, { x: event.clientX, y: event.clientY });
	}

	$effect(() => {
		const viewport = viewportElement;
		if (!viewport) return;
		const observer = new ResizeObserver(() => {
			if (session.image.mode === 'fit') fitToWindow();
		});
		observer.observe(viewport);
		const frame = requestAnimationFrame(() => {
			correctingScroll = true;
			viewport.scrollLeft = session.image.scrollLeft;
			viewport.scrollTop = session.image.scrollTop;
			if (session.image.mode === 'fit') fitToWindow();
			else restoreSavedManualFocalPoint();
			scheduleScrollRelease();
		});
		return () => {
			cancelAnimationFrame(frame);
			cancelPendingManualZoom();
			if (scrollReleaseFrame !== null) cancelAnimationFrame(scrollReleaseFrame);
			observer.disconnect();
			if (viewportElement) {
				session.image = {
					...session.image,
					scrollLeft: viewportElement.scrollLeft,
					scrollTop: viewportElement.scrollTop,
				};
			}
		};
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-11 shrink-0 items-center justify-end gap-1 border-b border-border px-3">
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => setManualScale(session.image.scale - ZOOM_STEP)}
			aria-label={m.image_zoom_out()}
			title={m.image_zoom_out()}
		>
			<ZoomOut class="h-4 w-4" />
		</Button>
		<span class="w-12 text-center text-xs tabular-nums text-muted-foreground">
			{Math.round(session.image.scale * 100)}%
		</span>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => setManualScale(session.image.scale + ZOOM_STEP)}
			aria-label={m.image_zoom_in()}
			title={m.image_zoom_in()}
		>
			<ZoomIn class="h-4 w-4" />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={fitToWindow}
			aria-label={m.image_fit_to_window()}
			title={m.image_fit_to_window()}
		>
			<Maximize class="h-4 w-4" />
		</Button>
	</div>
	<div
		bind:this={viewportElement}
		class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted p-4"
		onwheel={handleWheel}
		onscroll={persistViewport}
	>
		{#if session.imageObjectUrl}
			<img
				bind:this={imageElement}
				src={session.imageObjectUrl}
				alt={session.fileName}
				class="max-w-none object-contain"
				style:transform={`scale(${session.image.scale})`}
				style:transform-origin={`${session.image.focalX * 100}% ${session.image.focalY * 100}%`}
				onload={() => {
					if (session.image.mode === 'fit') fitToWindow();
					else restoreSavedManualFocalPoint();
				}}
			/>
		{/if}
	</div>
</div>
