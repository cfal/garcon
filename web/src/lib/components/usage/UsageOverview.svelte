<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import { isCostUnknown, type UsageMetric, type UsageReport } from '$lib/usage/usage-report';
	import {
		formatCount,
		formatPercent,
		formatTokens,
		formatUsd,
		formatUsdAxis,
	} from '$lib/usage/usage-format';
	import { usageAgentColor } from '$lib/usage/usage-presentation';
	import UsageChart from './UsageChart.svelte';

	interface Props {
		report: UsageReport;
		metric: UsageMetric;
		dimmed: boolean;
	}

	let { report, metric, dimmed }: Props = $props();

	const format = $derived(metric === 'cost' ? formatUsd : formatTokens);
	// An agent with no priced usage has an unknown cost, so it has no cost series.
	const series = $derived(
		report.agents
			.filter((agent) => metric === 'tokens' || !isCostUnknown(agent))
			.map((agent) => ({
				id: agent.agentId,
				label: agentLabelFor(agent.agentId),
				color: usageAgentColor(agent.agentId),
				values: report.daily.map((day) => {
					const point = day.byAgent.get(agent.agentId);
					return metric === 'cost' ? (point?.costUsd ?? 0) : (point?.totalTokens ?? 0);
				}),
				unknown: report.daily.map((day) => {
					const point = day.byAgent.get(agent.agentId);
					return metric === 'cost' && point !== undefined && isCostUnknown(point);
				}),
			})),
	);
	const totalCostUnknown = $derived(isCostUnknown(report.totals));
</script>

<section class="grid gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]" data-usage-overview>
	<div class="flex min-w-0 flex-col gap-5 transition-opacity" class:opacity-40={dimmed}>
		<div class="flex flex-col gap-1">
			<span class="text-4xl font-semibold text-foreground tabular-nums" data-usage-headline>
				{#if metric === 'tokens'}
					{formatTokens(report.totals.totalTokens)}
				{:else if totalCostUnknown}
					<span class="text-muted-foreground">{m.usage_unpriced()}</span>
				{:else}
					{formatUsd(report.totals.costUsd)}
				{/if}
			</span>
			<span class="text-xs text-muted-foreground">
				{m.usage_sessions({
					count: report.totals.sessions,
					formatted: formatCount(report.totals.sessions),
				})}
				{#if metric === 'cost'}· {m.usage_api_estimate()}{/if}
			</span>
			{#if metric === 'cost' && report.totals.unpricedTokens > 0}
				<span class="text-xs text-muted-foreground">
					{m.usage_excludes_unpriced({ tokens: formatTokens(report.totals.unpricedTokens) })}
				</span>
			{/if}
		</div>

		{#each report.agents as agent (agent.agentId)}
			{@const costUnknown = isCostUnknown(agent)}
			<svelte:boundary>
				<div class="flex flex-col gap-1" data-usage-agent={agent.agentId}>
					<div class="flex items-baseline justify-between gap-4">
						<span class="flex min-w-0 items-center gap-2 text-sm text-foreground">
							<span
								aria-hidden="true"
								class="size-2 shrink-0 rounded-full"
								style:background-color={usageAgentColor(agent.agentId)}
							></span>
							<span class="truncate">{agentLabelFor(agent.agentId)}</span>
							<span
								class="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
							>
								{m.usage_sessions({
									count: agent.sessions,
									formatted: formatCount(agent.sessions),
								})}
							</span>
						</span>
						<span class="shrink-0 text-sm font-medium text-foreground tabular-nums">
							{#if metric === 'tokens'}
								{formatTokens(agent.totalTokens)}
							{:else if costUnknown}
								<span class="text-muted-foreground">{m.usage_unpriced()}</span>
							{:else}
								{formatUsd(agent.costUsd)}
							{/if}
						</span>
					</div>
					<span class="text-xs text-muted-foreground">
						{#if metric === 'tokens'}
							{m.usage_agent_token_share({
								share: formatPercent(agent.tokenShare),
								cost: costUnknown ? m.usage_unpriced() : formatUsd(agent.costUsd),
							})}
						{:else if costUnknown}
							{m.usage_agent_unpriced({ tokens: formatTokens(agent.totalTokens) })}
						{:else}
							{m.usage_agent_cost_share({
								share: formatPercent(agent.costShare),
								tokens: formatTokens(agent.totalTokens),
							})}
						{/if}
					</span>
				</div>
				{#snippet failed()}
					<p class="text-xs text-muted-foreground">
						{m.usage_row_failed({ name: agentLabelFor(agent.agentId) })}
					</p>
				{/snippet}
			</svelte:boundary>
		{/each}
	</div>

	<div class="flex min-w-0 flex-col gap-3">
		<h2 class="text-sm font-medium text-foreground">
			{metric === 'cost' ? m.usage_daily_cost() : m.usage_daily_tokens()}
		</h2>
		<UsageChart
			days={report.days}
			{series}
			{format}
			formatAxis={metric === 'cost' ? formatUsdAxis : formatTokens}
			ariaLabel={metric === 'cost' ? m.usage_daily_cost() : m.usage_daily_tokens()}
			unknownLabel={m.usage_unpriced()}
			{dimmed}
		/>
	</div>
</section>
