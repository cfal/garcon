<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import { cn } from '$lib/utils/cn.js';
	import type { ModelSelectorRow } from './model-selector-types';

	interface Props {
		rows: ModelSelectorRow[];
		selectedValue: string;
		activeIndex: number;
		listId: string;
		ariaLabel: string;
		rowHeight?: number;
		overscan?: number;
		onActiveIndexChange: (index: number) => void;
		onSelect: (value: string) => void;
		onMetricsChange?: (metrics: { activeOptionId: string | undefined; visiblePageSize: number }) => void;
	}

	let {
		rows,
		selectedValue,
		activeIndex,
		listId,
		ariaLabel,
		rowHeight = 36,
		overscan = 8,
		onActiveIndexChange,
		onSelect,
		onMetricsChange,
	}: Props = $props();

	let viewport: HTMLDivElement | undefined = $state();
	let scrollTop = $state(0);
	let viewportHeight = $state(320);

	let totalHeight = $derived(rows.length * rowHeight);
	let startIndex = $derived(Math.min(rows.length, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)));
	let endIndex = $derived.by(() => {
		const visibleEnd = Math.ceil((scrollTop + viewportHeight) / rowHeight);
		return Math.min(rows.length, visibleEnd + overscan);
	});
	let visibleRows = $derived(rows.slice(startIndex, endIndex));
	let activeOptionId = $derived(
		activeIndex >= startIndex && activeIndex < endIndex && rows[activeIndex]
			? optionId(activeIndex)
			: undefined
	);
	let visiblePageSize = $derived(Math.max(1, Math.floor(viewportHeight / rowHeight)));

	function optionId(index: number): string {
		return `${listId}-option-${index}`;
	}

	function handleScroll(): void {
		if (!viewport) return;
		scrollTop = viewport.scrollTop;
	}

	function scrollIndexIntoView(index: number): void {
		if (!viewport || index < 0 || index >= rows.length) return;
		const top = index * rowHeight;
		const bottom = top + rowHeight;
		const viewportBottom = viewport.scrollTop + viewportHeight;

		if (top < viewport.scrollTop) {
			viewport.scrollTop = top;
			scrollTop = viewport.scrollTop;
			return;
		}
		if (bottom > viewportBottom) {
			viewport.scrollTop = bottom - viewportHeight;
			scrollTop = viewport.scrollTop;
		}
	}

	$effect(() => {
		if (!viewport || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				viewportHeight = Math.max(rowHeight, entry.contentRect.height);
			}
		});
		observer.observe(viewport);
		return () => observer.disconnect();
	});

	$effect(() => {
		rows;
		activeIndex;
		const frame = requestAnimationFrame(() => scrollIndexIntoView(activeIndex));
		return () => cancelAnimationFrame(frame);
	});

	$effect(() => {
		onMetricsChange?.({ activeOptionId, visiblePageSize });
	});
</script>

<div
	bind:this={viewport}
	data-model-list-viewport
	role="listbox"
	id={listId}
	aria-label={ariaLabel}
	class="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-1 [-webkit-overflow-scrolling:touch]"
	onscroll={handleScroll}
>
	<div style={`height:${totalHeight}px;`} class="relative">
		{#each visibleRows as row, visibleIndex (row.value)}
			{@const index = startIndex + visibleIndex}
			<button
				type="button"
				id={optionId(index)}
				role="option"
				aria-selected={index === activeIndex}
				data-model-index={index}
				style={`height:${rowHeight}px; transform:translateY(${index * rowHeight}px);`}
				class={cn(
					'absolute left-0 right-0 top-0 flex w-full touch-pan-y items-center gap-2 rounded-sm px-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
					index === activeIndex
						? 'bg-accent text-accent-foreground'
						: 'text-foreground hover:bg-accent/50 hover:text-accent-foreground'
				)}
				onmouseenter={() => onActiveIndexChange(index)}
				onclick={() => onSelect(row.value)}
			>
				<span class="min-w-0 flex-1">
					<span class="block truncate font-medium leading-none">{row.label}</span>
				</span>
				{#if row.value === selectedValue}
					<Check class="size-4 shrink-0" />
				{/if}
			</button>
		{/each}
	</div>
</div>
