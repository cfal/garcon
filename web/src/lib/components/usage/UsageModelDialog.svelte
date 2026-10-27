<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import {
		cacheHitRate,
		costPerMillionTokens,
		isCostUnknown,
		type UsageMetric,
		type UsageModelTotals,
	} from '$lib/usage/usage-report';
	import { formatPercent, formatTokens, formatUsd, formatUsdAxis } from '$lib/usage/usage-format';
	import {
		costTypeSegments,
		tokenTypeSegments,
		usageAgentColor,
	} from '$lib/usage/usage-presentation';
	import UsageChart from './UsageChart.svelte';
	import UsageShareBar from './UsageShareBar.svelte';

	interface Props {
		model: UsageModelTotals;
		days: readonly string[];
		metric: UsageMetric;
		onClose: () => void;
	}

	let { model, days, metric, onClose }: Props = $props();

	const agentLabel = $derived(agentLabelFor(model.agentId));
	const costUnknown = $derived(isCostUnknown(model));
	// Unpriced cost is unknown rather than zero, so its trend charts tokens.
	const chartMetric = $derived<UsageMetric>(costUnknown ? 'tokens' : metric);
	const stats = $derived.by(() => {
		const perMillion = costPerMillionTokens(model);
		const hitRate = cacheHitRate(model.tokens);
		return [
			{
				label: m.usage_metric_cost(),
				value: costUnknown ? m.usage_unpriced() : formatUsd(model.costUsd),
			},
			{ label: m.usage_metric_tokens(), value: formatTokens(model.totalTokens) },
			...(perMillion === null
				? []
				: [{ label: m.usage_per_million_tokens(), value: formatUsd(perMillion) }]),
			...(hitRate === null ? [] : [{ label: m.usage_cache_hit(), value: formatPercent(hitRate) }]),
		];
	});
	const series = $derived([
		{
			id: model.key,
			label: model.model,
			color: usageAgentColor(model.agentId),
			values: model.daily.map((point) =>
				chartMetric === 'cost' ? point.costUsd : point.totalTokens,
			),
			unknown: model.daily.map((point) => chartMetric === 'cost' && isCostUnknown(point)),
		},
	]);
</script>

<Dialog.Root
	open
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
>
	<Dialog.Content
		class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"
		data-usage-model-dialog
	>
		<Dialog.Header>
			<Dialog.Title class="flex min-w-0 items-center gap-2 pr-6">
				<span
					class="size-2.5 shrink-0 rounded-full"
					style:background-color={usageAgentColor(model.agentId)}
				></span>
				<span class="truncate">{model.model}</span>
			</Dialog.Title>
			<Dialog.Description>
				{costUnknown
					? agentLabel
					: m.usage_model_cost_share({ agent: agentLabel, share: formatPercent(model.costShare) })}
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-8">
			<dl class="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
				{#each stats as stat (stat.label)}
					<div class="flex min-w-0 flex-col gap-0.5">
						<dt class="text-xs text-muted-foreground">{stat.label}</dt>
						<dd class="truncate text-2xl font-semibold text-foreground tabular-nums">
							{stat.value}
						</dd>
					</div>
				{/each}
			</dl>

			<UsageChart
				{days}
				{series}
				format={chartMetric === 'cost' ? formatUsd : formatTokens}
				formatAxis={chartMetric === 'cost' ? formatUsdAxis : formatTokens}
				ariaLabel={chartMetric === 'cost' ? m.usage_daily_cost() : m.usage_daily_tokens()}
			/>

			<div class="grid gap-x-10 gap-y-8 sm:grid-cols-2">
				{#if !costUnknown}
					<UsageShareBar
						label={m.usage_cost_by_type()}
						segments={costTypeSegments(model.categoryCostUsd)}
						format={formatUsd}
					/>
				{/if}
				<UsageShareBar
					label={m.usage_tokens_by_type()}
					segments={tokenTypeSegments(model.tokens)}
					format={formatTokens}
				/>
			</div>
		</div>

		{#if model.unpricedTokens > 0}
			<Dialog.Footer class="sm:justify-start">
				<p class="text-xs text-muted-foreground">
					{m.usage_unpriced_tokens({ tokens: formatTokens(model.unpricedTokens) })}
				</p>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
