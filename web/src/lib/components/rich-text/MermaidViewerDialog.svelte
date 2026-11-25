<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { ZoomViewportController, type ZoomViewportView } from '$lib/components/shared/zoom-viewport-controller.svelte.js';
	import type { ZoomSize } from '$lib/components/shared/zoom-viewport.js';
	import * as m from '$lib/paraglide/messages.js';
	import Maximize from '@lucide/svelte/icons/maximize';
	import X from '@lucide/svelte/icons/x';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import ZoomOut from '@lucide/svelte/icons/zoom-out';
	import MermaidCopyButton from './MermaidCopyButton.svelte';

	interface Props {
		open: boolean;
		source: string;
		svg: string;
		onOpenChange: (open: boolean) => void;
	}

	let { open, source, svg, onOpenChange }: Props = $props();

	const ZOOM_STEP = 0.25;
	const ZOOM_MIN = 0.05;
	const ZOOM_MAX = 5;
	const FIT_ZOOM_MIN = 0;
	const VIEWPORT_PADDING = 24;

	let view = $state<ZoomViewportView>({ mode: 'fit', scale: 1 });
	let viewportElement = $state<HTMLDivElement | null>(null);
	let stageElement = $state<HTMLDivElement | null>(null);
	let displayedSource: string | null = null;
	const zoom = new ZoomViewportController({
		get viewport() { return viewportElement; },
		get content() { return stageElement; },
		get view() { return view; },
		readContentSize,
		padding: VIEWPORT_PADDING,
		minScale: ZOOM_MIN,
		maxScale: ZOOM_MAX,
		fitMinScale: FIT_ZOOM_MIN,
		input: 'pointer-gestures',
	});
	const zoomLabel = $derived(
		view.scale > 0 && view.scale < 0.01 ? '<1%' : `${Math.round(view.scale * 100)}%`,
	);

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

	function zoomIn() {
		zoom.zoomBy(ZOOM_STEP);
	}

	function zoomOut() {
		zoom.zoomBy(-ZOOM_STEP);
	}

	function fitToWindow() {
		if (zoom.fit()) zoom.centerAfterLayout();
	}

	function handleOpenChange(nextOpen: boolean) {
		if (!nextOpen) zoom.reset();
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

	$effect(() => {
		if (!open || !viewportElement || !stageElement) return;
		void svg;
		const nextSource = source;
		const shouldFit =
			displayedSource !== nextSource ||
			untrack(() => view.mode === 'fit');
		displayedSource = nextSource;
		return zoom.observe(
			viewportElement,
			() => {
				if (shouldFit) {
					fitToWindow();
					return;
				}
				const anchor = zoom.captureAnchor();
				zoom.updateGeometry();
				zoom.restoreAfterLayout(anchor);
			},
			() => {
				if (view.mode === 'fit') fitToWindow();
				else zoom.updateGeometry();
			},
		);
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
				<MermaidCopyButton {source} />
				<Button
					variant="ghost"
					size="icon-sm"
					onclick={zoomOut}
					disabled={view.scale <= zoom.minScale}
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
					disabled={view.scale >= ZOOM_MAX}
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

		<!-- Overflow makes this region keyboard-scrollable. Follow-up: sveltejs/svelte#11885. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			bind:this={viewportElement}
			class:cursor-grabbing={zoom.dragging || zoom.pinching}
			class:cursor-grab={zoom.canPan && !zoom.dragging && !zoom.pinching}
			class="mermaid-viewport min-h-0 flex-1 touch-none select-none overflow-auto bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
			role="region"
			aria-label={m.chat_mermaid_viewer_viewport()}
			tabindex="0"
			onwheel={(event) => zoom.wheel(event)}
			onpointerdown={(event) => zoom.pointerDown(event)}
			onpointermove={(event) => zoom.pointerMove(event)}
			onpointerup={(event) => zoom.removePointer(event.pointerId, true)}
			onpointercancel={(event) => zoom.removePointer(event.pointerId, true)}
			onlostpointercapture={(event) => zoom.removePointer(event.pointerId, false)}
		>
			<div
				class="mermaid-canvas relative"
				style:width={`${zoom.canvasWidth}px`}
				style:height={`${zoom.canvasHeight}px`}
			>
				<div
					bind:this={stageElement}
					class="mermaid-zoom-stage absolute"
					style:left={`${zoom.stageLeft}px`}
					style:top={`${zoom.stageTop}px`}
					style:width={`${zoom.stageWidth}px`}
					style:height={`${zoom.stageHeight}px`}
				>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- The viewer receives SVG generated by Mermaid in strict security mode. -->
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
