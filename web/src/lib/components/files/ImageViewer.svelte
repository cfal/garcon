<script lang="ts">
	import { ZoomIn, ZoomOut, Maximize } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import type { FileSession } from './file-session.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let { session }: { session: FileSession } = $props();
	let imageElement: HTMLImageElement | null = $state(null);
	let viewportElement: HTMLDivElement | null = $state(null);

	const ZOOM_STEP = 0.25;
	const ZOOM_MIN = 0.25;
	const ZOOM_MAX = 5;

	function setManualScale(scale: number): void {
		captureViewport();
		session.image = {
			...session.image,
			mode: 'manual',
			scale: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale)),
		};
		requestAnimationFrame(restoreManualFocalPoint);
	}

	function fitToWindow(): void {
		const image = imageElement;
		const viewport = viewportElement;
		if (!image || !viewport) return;
		const availableWidth = Math.max(1, viewport.clientWidth - 32);
		const availableHeight = Math.max(1, viewport.clientHeight - 32);
		const scale = Math.min(
			availableWidth / Math.max(1, image.naturalWidth),
			availableHeight / Math.max(1, image.naturalHeight),
			1,
		);
		session.image = {
			...session.image,
			mode: 'fit',
			scale: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale)),
			focalX: 0.5,
			focalY: 0.5,
			scrollLeft: 0,
			scrollTop: 0,
		};
	}

	function captureViewport(): void {
		if (!viewportElement || !imageElement) return;
		const viewportRect = viewportElement.getBoundingClientRect();
		const imageRect = imageElement.getBoundingClientRect();
		const focalX =
			imageRect.width > 0
				? Math.max(
						0,
						Math.min(
							1,
							(viewportRect.left + viewportRect.width / 2 - imageRect.left) / imageRect.width,
						),
					)
				: session.image.focalX;
		const focalY =
			imageRect.height > 0
				? Math.max(
						0,
						Math.min(
							1,
							(viewportRect.top + viewportRect.height / 2 - imageRect.top) / imageRect.height,
						),
					)
				: session.image.focalY;
		session.image = {
			...session.image,
			focalX,
			focalY,
			scrollLeft: viewportElement.scrollLeft,
			scrollTop: viewportElement.scrollTop,
		};
	}

	function restoreManualFocalPoint(): void {
		if (!viewportElement || !imageElement || session.image.mode !== 'manual') return;
		const viewportRect = viewportElement.getBoundingClientRect();
		const imageRect = imageElement.getBoundingClientRect();
		const focalLeft = imageRect.left + imageRect.width * session.image.focalX;
		const focalTop = imageRect.top + imageRect.height * session.image.focalY;
		viewportElement.scrollLeft += focalLeft - (viewportRect.left + viewportRect.width / 2);
		viewportElement.scrollTop += focalTop - (viewportRect.top + viewportRect.height / 2);
	}

	function handleWheel(event: WheelEvent): void {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		setManualScale(session.image.scale + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
	}

	$effect(() => {
		const viewport = viewportElement;
		if (!viewport) return;
		const observer = new ResizeObserver(() => {
			if (session.image.mode === 'fit') fitToWindow();
		});
		observer.observe(viewport);
		const frame = requestAnimationFrame(() => {
			viewport.scrollLeft = session.image.scrollLeft;
			viewport.scrollTop = session.image.scrollTop;
			if (session.image.mode === 'fit') fitToWindow();
			else restoreManualFocalPoint();
		});
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			captureViewport();
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
		onscroll={captureViewport}
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
					else restoreManualFocalPoint();
				}}
			/>
		{/if}
	</div>
</div>
