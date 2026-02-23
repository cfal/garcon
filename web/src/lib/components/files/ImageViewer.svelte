<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { X, ZoomIn, ZoomOut, Maximize } from '@lucide/svelte';
	import { apiFetch } from '$lib/api/client';
	import * as m from '$lib/paraglide/messages.js';

	interface ImageViewerProps {
		src: string;
		alt?: string;
		onClose: () => void;
	}

	let { src, alt = 'Image', onClose }: ImageViewerProps = $props();

	let imageUrl = $state<string | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let zoom = $state(1);
	let imageEl = $state<HTMLImageElement | null>(null);
	let viewportEl = $state<HTMLDivElement | null>(null);

	const ZOOM_STEP = 0.25;
	const ZOOM_MIN = 0.25;
	const ZOOM_MAX = 5;

	function zoomIn() {
		zoom = Math.min(zoom + ZOOM_STEP, ZOOM_MAX);
	}

	function zoomOut() {
		zoom = Math.max(zoom - ZOOM_STEP, ZOOM_MIN);
	}

	function fitToWindow() {
		if (!imageEl || !viewportEl) {
			zoom = 1;
			return;
		}
		const containerWidth = viewportEl.clientWidth - 24;
		const containerHeight = viewportEl.clientHeight - 24;
		const naturalWidth = imageEl.naturalWidth || imageEl.width;
		const naturalHeight = imageEl.naturalHeight || imageEl.height;
		if (naturalWidth <= 0 || naturalHeight <= 0) {
			zoom = 1;
			return;
		}
		const fitScale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight, 1);
		zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fitScale));
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		} else if (e.key === '+' || e.key === '=') {
			zoomIn();
		} else if (e.key === '-') {
			zoomOut();
		} else if (e.key === '0') {
			fitToWindow();
		}
	}

	// Handles mouse wheel zoom while holding Ctrl/Meta.
	function handleWheel(e: WheelEvent) {
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			if (e.deltaY < 0) {
				zoomIn();
			} else {
				zoomOut();
			}
		}
	}

	let controller: AbortController | undefined;

	onMount(async () => {
		controller = new AbortController();
		try {
			loading = true;
			error = null;

			const response = await apiFetch(src, {
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`Request failed with status ${response.status}`);
			}

			const blob = await response.blob();
			imageUrl = URL.createObjectURL(blob);
		} catch (err: unknown) {
			if (err instanceof Error && err.name === 'AbortError') return;
			console.error('Error loading image:', err);
			error = m.image_unable_to_load();
		} finally {
			loading = false;
		}
	});

	$effect(() => {
		if (!imageUrl || !imageEl) return;
		fitToWindow();
	});

	onDestroy(() => {
		controller?.abort();
		if (imageUrl) {
			URL.revokeObjectURL(imageUrl);
		}
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -- modal backdrop with role=presentation, Escape handled separately -->
<div
	class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
	role="presentation"
	onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
	onwheel={handleWheel}
>
	<div class="bg-background rounded-lg shadow-xl max-w-4xl max-h-[90vh] w-full mx-4 overflow-hidden flex flex-col">
		<!-- Header -->
		<div class="flex items-center justify-between p-4 border-b border-border flex-shrink-0">
			<h3 class="text-lg font-semibold text-foreground truncate">{alt}</h3>
			<div class="flex items-center gap-1">
				<Button variant="ghost" size="icon-sm" onclick={zoomOut} title={m.image_zoom_out()}>
					<ZoomOut class="w-4 h-4" />
				</Button>
				<span class="text-sm text-muted-foreground w-12 text-center">
					{Math.round(zoom * 100)}%
				</span>
				<Button variant="ghost" size="icon-sm" onclick={zoomIn} title={m.image_zoom_in()}>
					<ZoomIn class="w-4 h-4" />
				</Button>
				<Button variant="ghost" size="icon-sm" onclick={fitToWindow} title={m.image_fit_to_window()}>
					<Maximize class="w-4 h-4" />
				</Button>
				<Button variant="ghost" size="icon-sm" onclick={onClose} title={m.image_close()}>
					<X class="w-4 h-4" />
				</Button>
			</div>
		</div>

		<!-- Image area -->
		<div bind:this={viewportEl} class="flex-1 overflow-auto flex justify-center items-center bg-muted min-h-[400px] p-4">
			{#if loading}
				<div class="text-center text-muted-foreground">
					<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-3"></div>
					<p>{m.image_loading()}</p>
				</div>
			{:else if imageUrl}
				<img
					bind:this={imageEl}
					src={imageUrl}
					alt={alt}
					class="max-w-full object-contain rounded-lg shadow-md transition-transform duration-150"
					style="transform: scale({zoom}); transform-origin: center center;"
				/>
			{:else}
				<div class="text-center text-muted-foreground">
					<p>{error || m.image_unable_to_load()}</p>
					<p class="text-sm mt-2 break-all">{src}</p>
				</div>
			{/if}
		</div>

		<!-- Footer -->
		<div class="p-3 border-t border-border bg-muted flex-shrink-0">
			<p class="text-sm text-muted-foreground truncate">{src}</p>
		</div>
	</div>
</div>
