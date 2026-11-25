<script lang="ts">
	import Maximize from '@lucide/svelte/icons/maximize';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import ZoomOut from '@lucide/svelte/icons/zoom-out';
	import { Button } from '$lib/components/ui/button';
	import { ZoomViewportController } from '$lib/components/shared/zoom-viewport-controller.svelte.js';
	import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import * as m from '$lib/paraglide/messages.js';

	let { session }: { session: FileViewSession } = $props();
	let imageElement: HTMLImageElement | null = $state(null);
	let viewportElement: HTMLDivElement | null = $state(null);

	const ZOOM_STEP = 0.25;
	const ZOOM_MIN = 0.25;
	const ZOOM_MAX = 5;
	const VIEWPORT_PADDING = 16;
	const primaryScrollRegion = nativeWorkspaceScrollRegion('primary');
	let savedViewportFrame: number | null = null;
	let scrollReleaseFrame: number | null = null;
	let correctingScroll = false;
	const zoom = new ZoomViewportController({
		get viewport() { return viewportElement; },
		get content() { return imageElement; },
		get view() { return session.image; },
		readContentSize() {
			const width = imageElement?.naturalWidth ?? 0;
			const height = imageElement?.naturalHeight ?? 0;
			return width > 0 && height > 0 ? { width, height } : null;
		},
		padding: VIEWPORT_PADDING,
		minScale: ZOOM_MIN,
		maxScale: ZOOM_MAX,
		input: 'native-scroll',
		onAnchorRestored(viewport) {
			session.image.scrollLeft = viewport.scrollLeft;
			session.image.scrollTop = viewport.scrollTop;
			correctingScroll = true;
			scheduleScrollRelease();
		},
	});

	function scheduleScrollRelease(): void {
		if (scrollReleaseFrame !== null) cancelAnimationFrame(scrollReleaseFrame);
		scrollReleaseFrame = requestAnimationFrame(() => {
			scrollReleaseFrame = null;
			correctingScroll = false;
		});
	}

	function fitToWindow(): void {
		const viewport = viewportElement;
		if (!viewport || !zoom.fit()) return;
		session.image.scrollLeft = 0;
		session.image.scrollTop = 0;
		correctingScroll = true;
		viewport.scrollLeft = 0;
		viewport.scrollTop = 0;
		scheduleScrollRelease();
	}

	function persistViewport(viewport = viewportElement): void {
		if (!viewport || correctingScroll) return;
		session.image.scrollLeft = viewport.scrollLeft;
		session.image.scrollTop = viewport.scrollTop;
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
		if (!zoom.updateGeometry()) return;
		if (session.image.mode === 'fit') fitToWindow();
		else scheduleSavedViewportRestore();
	}

	$effect(() => {
		const viewport = viewportElement;
		if (!viewport) return;
		correctingScroll = true;
		const stop = zoom.observe(
			viewport,
			() => {
				if (session.image.mode === 'fit') fitToWindow();
				else {
					zoom.updateGeometry();
					restoreSavedViewport();
				}
				scheduleScrollRelease();
			},
			() => {
				if (session.image.mode === 'fit') fitToWindow();
				else zoom.updateGeometry();
			},
		);
		// Scroll events persist offsets before detached browser viewports report zero.
		return () => {
			stop();
			if (savedViewportFrame !== null) cancelAnimationFrame(savedViewportFrame);
			if (scrollReleaseFrame !== null) cancelAnimationFrame(scrollReleaseFrame);
		};
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex h-11 shrink-0 items-center justify-end gap-1 border-b border-border px-3">
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={() => zoom.zoomBy(-ZOOM_STEP)}
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
			onclick={() => zoom.zoomBy(ZOOM_STEP)}
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
		onwheel={(event) => zoom.wheel(event)}
		onscroll={(event) => persistViewport(event.currentTarget)}
	>
		<div class="relative" style:width={`${zoom.canvasWidth}px`} style:height={`${zoom.canvasHeight}px`}>
			{#if session.imageObjectUrl}
				<div
					class="absolute"
					style:left={`${zoom.stageLeft}px`}
					style:top={`${zoom.stageTop}px`}
					style:width={`${zoom.stageWidth}px`}
					style:height={`${zoom.stageHeight}px`}
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
