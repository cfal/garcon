<script lang="ts">
	import Maximize from '@lucide/svelte/icons/maximize';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import ZoomOut from '@lucide/svelte/icons/zoom-out';
	import { Button } from '$lib/components/ui/button';
	import {
		calculateFitScale,
		captureZoomAnchor,
		restoreZoomAnchor,
		type ZoomAnchor,
		type ZoomPoint,
		type ZoomSize,
	} from '$lib/components/shared/zoom-viewport.js';
	import type { FileSession } from '$lib/files/sessions/file-session.svelte.js';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import * as m from '$lib/paraglide/messages.js';

	let { session }: { session: FileSession } = $props();
	let imageElement: HTMLImageElement | null = $state(null);
	let viewportElement: HTMLDivElement | null = $state(null);

	const ZOOM_STEP = 0.25;
	const ZOOM_MIN = 0.25;
	const ZOOM_MAX = 5;
	const VIEWPORT_PADDING = 16;
	const primaryScrollRegion = nativeWorkspaceScrollRegion('primary');
	let viewportSize = $state<ZoomSize>({ width: 1, height: 1 });
	let naturalSize = $state<ZoomSize>({ width: 0, height: 0 });
	let pendingZoomAnchor: ZoomAnchor | null = null;
	let zoomFrame: number | null = null;
	let savedViewportFrame: number | null = null;
	let scrollReleaseFrame: number | null = null;
	let correctingScroll = false;
	const stageWidth = $derived(naturalSize.width * session.image.scale);
	const stageHeight = $derived(naturalSize.height * session.image.scale);
	const canvasWidth = $derived(Math.max(viewportSize.width, stageWidth + VIEWPORT_PADDING * 2));
	const canvasHeight = $derived(Math.max(viewportSize.height, stageHeight + VIEWPORT_PADDING * 2));
	const stageLeft = $derived((canvasWidth - stageWidth) / 2);
	const stageTop = $derived((canvasHeight - stageHeight) / 2);

	function cancelPendingManualZoom(): void {
		if (zoomFrame !== null) cancelAnimationFrame(zoomFrame);
		zoomFrame = null;
		pendingZoomAnchor = null;
	}

	function updateViewportSize(): void {
		if (!viewportElement) return;
		const width = Math.max(1, viewportElement.clientWidth);
		const height = Math.max(1, viewportElement.clientHeight);
		if (viewportSize.width === width && viewportSize.height === height) return;
		viewportSize = { width, height };
	}

	function updateNaturalSize(): boolean {
		if (!imageElement || imageElement.naturalWidth <= 0 || imageElement.naturalHeight <= 0) {
			return false;
		}
		const width = imageElement.naturalWidth;
		const height = imageElement.naturalHeight;
		if (naturalSize.width !== width || naturalSize.height !== height) {
			naturalSize = { width, height };
		}
		return true;
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
		session.image.mode = 'manual';
		session.image.scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
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
		const viewport = viewportElement;
		if (!viewport || !updateNaturalSize()) return;
		cancelPendingManualZoom();
		updateViewportSize();
		const scale = calculateFitScale({
			viewport: viewportSize,
			content: naturalSize,
			padding: VIEWPORT_PADDING,
			minScale: ZOOM_MIN,
			maxScale: ZOOM_MAX,
		});
		session.image.mode = 'fit';
		session.image.scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
		session.image.scrollLeft = 0;
		session.image.scrollTop = 0;
		correctingScroll = true;
		viewport.scrollLeft = 0;
		viewport.scrollTop = 0;
		scheduleScrollRelease();
	}

	function captureViewport(client?: ZoomPoint): ZoomAnchor | null {
		if (!viewportElement || !imageElement) return null;
		const viewportRect = viewportElement.getBoundingClientRect();
		const imageRect = imageElement.getBoundingClientRect();
		return captureZoomAnchor(viewportRect, imageRect, client);
	}

	function persistViewport(viewport = viewportElement): void {
		if (!viewport || correctingScroll) return;
		session.image.scrollLeft = viewport.scrollLeft;
		session.image.scrollTop = viewport.scrollTop;
	}

	function restoreManualFocalPoint(anchor: ZoomAnchor): void {
		if (!viewportElement || !imageElement || session.image.mode !== 'manual') return;
		const imageRect = imageElement.getBoundingClientRect();
		correctingScroll = true;
		restoreZoomAnchor(viewportElement, imageRect, anchor);
		session.image.scrollLeft = viewportElement.scrollLeft;
		session.image.scrollTop = viewportElement.scrollTop;
		scheduleScrollRelease();
	}

	function restoreSavedViewport(): void {
		if (!viewportElement || session.image.mode !== 'manual') return;
		correctingScroll = true;
		viewportElement.scrollLeft = session.image.scrollLeft;
		viewportElement.scrollTop = session.image.scrollTop;
		scheduleScrollRelease();
	}

	function scheduleSavedViewportRestore(): void {
		if (savedViewportFrame !== null) cancelAnimationFrame(savedViewportFrame);
		savedViewportFrame = requestAnimationFrame(() => {
			savedViewportFrame = null;
			restoreSavedViewport();
		});
	}

	function handleImageLoad(): void {
		if (!updateNaturalSize()) return;
		if (session.image.mode === 'fit') fitToWindow();
		else scheduleSavedViewportRestore();
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
		let resizeFrame: number | null = null;
		const observer = new ResizeObserver(() => {
			if (resizeFrame !== null) return;
			resizeFrame = requestAnimationFrame(() => {
				resizeFrame = null;
				updateViewportSize();
				if (session.image.mode === 'fit') fitToWindow();
			});
		});
		observer.observe(viewport);
		correctingScroll = true;
		const frame = requestAnimationFrame(() => {
			updateViewportSize();
			if (session.image.mode === 'fit') fitToWindow();
			else restoreSavedViewport();
			scheduleScrollRelease();
		});
		// Scroll events persist offsets before detached browser viewports report zero.
		return () => {
			cancelAnimationFrame(frame);
			cancelPendingManualZoom();
			if (savedViewportFrame !== null) cancelAnimationFrame(savedViewportFrame);
			if (scrollReleaseFrame !== null) cancelAnimationFrame(scrollReleaseFrame);
			if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
			observer.disconnect();
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
		{@attach primaryScrollRegion}
		class="min-h-0 flex-1 overflow-auto bg-muted"
		onwheel={handleWheel}
		onscroll={(event) => persistViewport(event.currentTarget)}
	>
		<div class="relative" style:width={`${canvasWidth}px`} style:height={`${canvasHeight}px`}>
			{#if session.imageObjectUrl}
				<div
					class="absolute"
					style:left={`${stageLeft}px`}
					style:top={`${stageTop}px`}
					style:width={`${stageWidth}px`}
					style:height={`${stageHeight}px`}
				>
					<img
						bind:this={imageElement}
						src={session.imageObjectUrl}
						alt={session.fileName}
						class="block size-full max-w-none object-contain"
						onload={handleImageLoad}
					/>
				</div>
			{/if}
		</div>
	</div>
</div>
