<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { cacheHitRate, type UsageMetric, type UsageReport } from '$lib/usage/usage-report';
	import { formatPercent, formatTokens, formatUsd } from '$lib/usage/usage-format';
	import { costTypeSegments, tokenTypeSegments } from '$lib/usage/usage-presentation';
	import UsageShareBar from './UsageShareBar.svelte';

	interface Props {
		report: UsageReport;
		metric: UsageMetric;
		dimmed: boolean;
	}

	let { report, metric, dimmed }: Props = $props();

	const totals = $derived(report.totals);
	const hitRate = $derived(cacheHitRate(totals.tokens));
	const metrics = $derived([
		{ id: 'processed', label: m.usage_processed_tokens(), value: formatTokens(totals.totalTokens) },
		{
			id: 'cache-read',
			label: m.usage_type_cache_read(),
			value: formatTokens(totals.tokens.cachedInputTokens),
		},
		{
			id: 'cache-write',
			label: m.usage_type_cache_write(),
			value: formatTokens(totals.tokens.cacheWriteTokens),
		},
		{
			id: 'input',
			label: m.usage_uncached_input(),
			value: formatTokens(totals.tokens.uncachedInputTokens),
		},
		{ id: 'output', label: m.usage_type_output(), value: formatTokens(totals.tokens.outputTokens) },
		...(hitRate === null
			? []
			: [{ id: 'hit-rate', label: m.usage_cache_hit(), value: formatPercent(hitRate) }]),
		...(totals.cacheSavingsUsd > 0
			? [
					{
						id: 'savings',
						label: m.usage_cache_savings(),
						value: formatUsd(totals.cacheSavingsUsd),
					},
				]
			: []),
	]);
</script>

<section class="flex flex-col gap-2 transition-opacity" class:opacity-40={dimmed} data-usage-totals>
	<h2 class="text-sm font-medium text-foreground">{m.usage_totals()}</h2>
	<dl class="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-6 gap-y-4 py-1">
		{#each metrics as entry (entry.id)}
			<div class="flex min-w-0 flex-col gap-0.5">
				<dt class="text-xs text-muted-foreground">{entry.label}</dt>
				<dd class="text-base font-medium text-foreground tabular-nums">{entry.value}</dd>
			</div>
		{/each}
	</dl>
</section>

{#if totals.totalTokens > 0}
	<section
		class="grid gap-x-12 gap-y-8 transition-opacity lg:grid-cols-2"
		class:opacity-40={dimmed}
	>
		<UsageShareBar
			label={m.usage_tokens_by_type()}
			segments={tokenTypeSegments(totals.tokens)}
			format={formatTokens}
		/>
		{#if totals.costUsd > 0}
			<!-- The selected metric's breakdown comes first. -->
			<div class="min-w-0" class:order-first={metric === 'cost'}>
				<UsageShareBar
					label={m.usage_cost_by_type()}
					segments={costTypeSegments(totals.categoryCostUsd)}
					format={formatUsd}
				/>
			</div>
		{/if}
	</section>
{/if}
