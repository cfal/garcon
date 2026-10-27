<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import {
		CHART_VIEW_HEIGHT,
		CHART_VIEW_WIDTH,
		indexAtFraction,
		indexToX,
		niceScale,
		seriesPaths,
		valueToY,
		type UsageChartSeries,
	} from '$lib/usage/usage-chart-geometry';
	import { formatDayLong, formatDayShort } from '$lib/usage/usage-format';

	interface Props {
		days: readonly string[];
		series: readonly UsageChartSeries[];
		format: (value: number) => string;
		formatAxis: (value: number) => string;
		ariaLabel: string;
		dimmed?: boolean;
	}

	let { days, series, format, formatAxis, ariaLabel, dimmed = false }: Props = $props();

	const TOOLTIP_GAP_PX = 12;

	let hoverIndex = $state<number | null>(null);
	let pointer = $state({ x: 0, y: 0 });
	let plotWidth = $state(0);
	let plotHeight = $state(0);
	let tooltipWidth = $state(0);
	let tooltipHeight = $state(0);
	let plot = $state<HTMLDivElement | null>(null);

	// Series overlap rather than stack, so the scale fits the tallest single value.
	const scale = $derived(
		niceScale(series.reduce((peak, entry) => Math.max(peak, ...entry.values), 0)),
	);
	// The largest series draws first so smaller ones stay visible on top.
	const paths = $derived(
		series
			.map((entry) => ({
				...entry,
				total: entry.values.reduce((sum, value) => sum + value, 0),
				...seriesPaths(entry.values, scale.max),
			}))
			.toSorted((left, right) => right.total - left.total),
	);
	const tooltipLeft = $derived.by(() => {
		const preferred =
			pointer.x + TOOLTIP_GAP_PX + tooltipWidth <= plotWidth
				? pointer.x + TOOLTIP_GAP_PX
				: pointer.x - TOOLTIP_GAP_PX - tooltipWidth;
		return Math.min(Math.max(0, preferred), Math.max(0, plotWidth - tooltipWidth));
	});
	const tooltipTop = $derived.by(() => {
		const preferred =
			pointer.y + TOOLTIP_GAP_PX + tooltipHeight <= plotHeight
				? pointer.y + TOOLTIP_GAP_PX
				: pointer.y - TOOLTIP_GAP_PX - tooltipHeight;
		return Math.min(Math.max(0, preferred), Math.max(0, plotHeight - tooltipHeight));
	});
	const axisDays = $derived(
		days.length === 0
			? []
			: [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])].map(
					(index) => days[index]!,
				),
	);
	const hoverTotal = $derived(
		hoverIndex === null
			? 0
			: series.reduce((sum, entry) => sum + (entry.values[hoverIndex!] ?? 0), 0),
	);

	function handlePointerMove(event: PointerEvent): void {
		if (!plot || days.length === 0) return;
		const bounds = plot.getBoundingClientRect();
		if (bounds.width === 0) return;
		const x = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
		const y = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
		pointer = { x, y };
		hoverIndex = indexAtFraction(x / bounds.width, days.length);
	}
</script>

<div class="flex flex-col gap-1" data-usage-chart>
	<div class="flex gap-2">
		<div class="relative h-56 w-12 shrink-0" aria-hidden="true">
			{#if scale.max > 0}
				{#each scale.ticks as tick (tick)}
					<span
						class="absolute right-0 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
						style:top={`${(valueToY(tick, scale.max) / CHART_VIEW_HEIGHT) * 100}%`}
					>
						{tick === 0 ? '0' : formatAxis(tick)}
					</span>
				{/each}
			{/if}
		</div>
		<div
			bind:this={plot}
			bind:clientWidth={plotWidth}
			bind:clientHeight={plotHeight}
			class="relative h-56 min-w-0 flex-1 transition-opacity"
			class:opacity-40={dimmed}
			role="presentation"
			onpointermove={handlePointerMove}
			onpointerleave={() => (hoverIndex = null)}
		>
			<svg
				class="h-full w-full overflow-visible"
				viewBox={`0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}`}
				preserveAspectRatio="none"
				role="img"
				aria-label={ariaLabel}
			>
				{#each scale.ticks as tick (tick)}
					<line
						x1="0"
						x2={CHART_VIEW_WIDTH}
						y1={valueToY(tick, scale.max)}
						y2={valueToY(tick, scale.max)}
						class="stroke-border"
						stroke-width="1"
						vector-effect="non-scaling-stroke"
					/>
				{/each}
				{#each paths as path (path.id)}
					<path d={path.area} fill={path.color} fill-opacity="0.12" />
				{/each}
				{#each paths as path (path.id)}
					<path
						d={path.line}
						fill="none"
						stroke={path.color}
						stroke-width="2"
						stroke-linejoin="round"
						vector-effect="non-scaling-stroke"
					/>
				{/each}
				{#if hoverIndex !== null}
					<line
						x1={indexToX(hoverIndex, days.length)}
						x2={indexToX(hoverIndex, days.length)}
						y1="0"
						y2={CHART_VIEW_HEIGHT}
						class="stroke-muted-foreground"
						stroke-width="1"
						vector-effect="non-scaling-stroke"
					/>
				{/if}
			</svg>
			{#if hoverIndex !== null && days[hoverIndex]}
				<div
					bind:offsetWidth={tooltipWidth}
					bind:offsetHeight={tooltipHeight}
					aria-hidden="true"
					class="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg"
					style:left={`${tooltipLeft}px`}
					style:top={`${tooltipTop}px`}
					data-usage-chart-tooltip
				>
					<div class="mb-1 text-muted-foreground">{formatDayLong(days[hoverIndex])}</div>
					{#each series as entry (entry.id)}
						<div class="flex items-center justify-between gap-3">
							<span class="flex min-w-0 items-center gap-1.5 text-muted-foreground">
								<span class="size-2 shrink-0 rounded-full" style:background-color={entry.color}
								></span>
								<span class="truncate">{entry.label}</span>
							</span>
							<span class="text-foreground tabular-nums"
								>{format(entry.values[hoverIndex] ?? 0)}</span
							>
						</div>
					{/each}
					{#if series.length > 1}
						<div class="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
							<span class="text-muted-foreground">{m.usage_total()}</span>
							<span class="text-foreground tabular-nums">{format(hoverTotal)}</span>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
	<div
		class="flex justify-between pl-14 text-[10px] text-muted-foreground uppercase"
		aria-hidden="true"
	>
		{#each axisDays as day (day)}
			<span>{formatDayShort(day)}</span>
		{/each}
	</div>
</div>
