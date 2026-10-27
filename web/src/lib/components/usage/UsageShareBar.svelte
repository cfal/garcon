<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ShareSegment } from '$lib/usage/usage-presentation';
	import { formatPercent } from '$lib/usage/usage-format';

	interface Props {
		label: string;
		segments: readonly ShareSegment[];
		format: (value: number) => string;
		aside?: Snippet;
	}

	let { label, segments, format, aside }: Props = $props();

	const visible = $derived(segments.filter((segment) => segment.value > 0));
	const total = $derived(visible.reduce((sum, segment) => sum + segment.value, 0));
	const description = $derived(
		visible.map((segment) => `${segment.label} ${format(segment.value)}`).join(', '),
	);
</script>

{#if total > 0}
	<div class="flex min-w-0 flex-col gap-2.5" data-usage-share-bar>
		<div class="flex items-baseline justify-between gap-3">
			<h3 class="text-sm font-medium text-foreground">{label}</h3>
			{@render aside?.()}
		</div>
		<div role="img" aria-label={`${label}: ${description}`} class="flex h-2 gap-0.5">
			{#each visible as segment (segment.id)}
				<div
					class="h-full min-w-1 rounded-[2px] first:rounded-l-full last:rounded-r-full"
					style:flex={`${segment.value} 1 0`}
					style:background-color={segment.color}
					title={`${segment.label} · ${format(segment.value)} · ${formatPercent(segment.value / total)}`}
				></div>
			{/each}
		</div>
		<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
			{#each visible as segment (segment.id)}
				<span class="flex items-center gap-1.5">
					<span aria-hidden="true" class="size-2 rounded-[2px]" style:background-color={segment.color}
					></span>
					<span class="text-muted-foreground">{segment.label}</span>
					<span class="text-foreground tabular-nums">{format(segment.value)}</span>
				</span>
			{/each}
		</div>
	</div>
{/if}
