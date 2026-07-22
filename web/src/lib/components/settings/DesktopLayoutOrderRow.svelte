<script lang="ts">
	import { onMount, tick } from 'svelte';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
	import {
		draggable,
		dropTargetForElements,
	} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	import {
		attachClosestEdge,
		extractClosestEdge,
		type Edge,
	} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
	import { Button } from '$lib/components/ui/button/index.js';
	import { isDesktopLayoutPane, type DesktopLayoutPane } from '$lib/layout/desktop-layout.js';
	import * as m from '$lib/paraglide/messages.js';

	interface DesktopLayoutDragData {
		type: 'desktop-layout-pane';
		pane: DesktopLayoutPane;
	}

	let {
		pane,
		label,
		index,
		count,
		onMove,
		onDrop,
	}: {
		pane: DesktopLayoutPane;
		label: string;
		index: number;
		count: number;
		onMove: (pane: DesktopLayoutPane, delta: -1 | 1) => void;
		onDrop: (source: DesktopLayoutPane, target: DesktopLayoutPane, edge: Edge) => void;
	} = $props();

	let rowElement: HTMLLIElement | null = $state(null);
	let dragHandleElement: HTMLSpanElement | null = $state(null);
	let upButtonElement: HTMLElement | null = $state(null);
	let downButtonElement: HTMLElement | null = $state(null);
	let isDragging = $state(false);
	let dropIndicatorEdge = $state<Edge | null>(null);

	async function move(delta: -1 | 1): Promise<void> {
		const requestedButton = delta === -1 ? upButtonElement : downButtonElement;
		const fallbackButton = delta === -1 ? downButtonElement : upButtonElement;
		onMove(pane, delta);
		await tick();
		(requestedButton?.matches(':disabled') ? fallbackButton : requestedButton)?.focus();
	}

	function isDesktopLayoutDragData(
		value: Record<string | symbol, unknown>,
	): value is Record<string | symbol, unknown> & DesktopLayoutDragData {
		return value.type === 'desktop-layout-pane' && isDesktopLayoutPane(value.pane);
	}

	onMount(() => {
		if (!rowElement || !dragHandleElement) return;
		return combine(
			draggable({
				element: rowElement,
				dragHandle: dragHandleElement,
				getInitialData: () => ({ type: 'desktop-layout-pane', pane }),
				onDragStart: () => (isDragging = true),
				onDrop: () => (isDragging = false),
			}),
			dropTargetForElements({
				element: rowElement,
				canDrop: ({ source }) => isDesktopLayoutDragData(source.data) && source.data.pane !== pane,
				getData: ({ input, element }) =>
					attachClosestEdge(
						{ type: 'desktop-layout-pane', pane },
						{ input, element, allowedEdges: ['top', 'bottom'] },
					),
				getDropEffect: () => 'move',
				onDragEnter: ({ self }) => (dropIndicatorEdge = extractClosestEdge(self.data)),
				onDrag: ({ self }) => (dropIndicatorEdge = extractClosestEdge(self.data)),
				onDragLeave: () => (dropIndicatorEdge = null),
				onDrop: ({ source, self }) => {
					const edge = extractClosestEdge(self.data);
					dropIndicatorEdge = null;
					if (isDesktopLayoutDragData(source.data) && edge) {
						onDrop(source.data.pane, pane, edge);
					}
				},
			}),
		);
	});
</script>

<li
	bind:this={rowElement}
	data-desktop-layout-setting-pane={pane}
	class="relative flex h-11 items-center gap-2 px-2 transition-opacity"
	class:opacity-50={isDragging}
>
	{#if dropIndicatorEdge === 'top'}
		<div class="pointer-events-none absolute inset-x-2 top-0 h-0.5 bg-primary"></div>
	{:else if dropIndicatorEdge === 'bottom'}
		<div class="pointer-events-none absolute inset-x-2 bottom-0 h-0.5 bg-primary"></div>
	{/if}

	<span
		bind:this={dragHandleElement}
		class="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing"
		aria-label={m.settings_desktop_layout_drag_handle({ pane: label })}
		role="img"
	>
		<GripVertical class="size-4" />
	</span>
	<span class="min-w-0 flex-1 text-sm text-foreground">{label}</span>
	<div class="flex shrink-0 items-center gap-1">
		<Button
			bind:ref={upButtonElement}
			variant="ghost"
			size="icon-sm"
			disabled={index === 0}
			onclick={() => void move(-1)}
			aria-label={m.settings_desktop_layout_move_up({ pane: label })}
			title={m.settings_desktop_layout_move_up({ pane: label })}
		>
			<ChevronUp class="size-3.5" />
		</Button>
		<Button
			bind:ref={downButtonElement}
			variant="ghost"
			size="icon-sm"
			disabled={index === count - 1}
			onclick={() => void move(1)}
			aria-label={m.settings_desktop_layout_move_down({ pane: label })}
			title={m.settings_desktop_layout_move_down({ pane: label })}
		>
			<ChevronDown class="size-3.5" />
		</Button>
	</div>
</li>
