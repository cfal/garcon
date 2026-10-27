<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import type { UsageBreakdownKind } from '$lib/usage/usage-controller.svelte';
	import {
		isCostUnknown,
		metricValue,
		sortModels,
		type UsageMetric,
		type UsageReport,
	} from '$lib/usage/usage-report';
	import {
		formatDayWithYear,
		formatPercent,
		formatTokens,
		formatUsd,
	} from '$lib/usage/usage-format';
	import { usageAgentColor } from '$lib/usage/usage-presentation';
	import UsageSegmented from './UsageSegmented.svelte';

	interface Props {
		report: UsageReport;
		metric: UsageMetric;
		breakdown: UsageBreakdownKind;
		dimmed: boolean;
		onBreakdownChange: (breakdown: UsageBreakdownKind) => void;
		onOpenModel: (key: string) => void;
	}

	let { report, metric, breakdown, dimmed, onBreakdownChange, onOpenModel }: Props = $props();

	const models = $derived(sortModels(report.models, metric));
	const peak = $derived(
		models.reduce((max, model) => Math.max(max, metricValue(model, metric)), 0),
	);
	const activeDays = $derived(report.daily.filter((day) => day.totalTokens > 0).toReversed());
	const breakdownOptions = $derived([
		{ value: 'model' as const, label: m.usage_breakdown_model() },
		{ value: 'day' as const, label: m.usage_breakdown_day() },
	]);
</script>

<section class="flex flex-col gap-3" data-usage-breakdown>
	<div class="flex items-center justify-between gap-3">
		<h2 class="text-sm font-medium text-foreground">{m.usage_breakdown()}</h2>
		<UsageSegmented
			label={m.usage_breakdown()}
			options={breakdownOptions}
			value={breakdown}
			onChange={onBreakdownChange}
		/>
	</div>

	<div class="overflow-x-auto transition-opacity" class:opacity-40={dimmed}>
		{#if breakdown === 'model'}
			<table class="w-full text-sm" data-usage-model-table>
				<thead>
					<tr class="border-b border-border text-right text-xs text-muted-foreground">
						<th scope="col" class="py-2 pr-3 text-left font-normal">#</th>
						<th scope="col" class="w-full py-2 text-left font-normal">{m.usage_column_model()}</th>
						<th scope="col" class="py-2 pl-6 font-normal">{m.usage_metric_cost()}</th>
						<th scope="col" class="hidden py-2 pl-6 font-normal sm:table-cell"
							>{m.usage_column_share()}</th
						>
						<th scope="col" class="py-2 pl-6 font-normal">{m.usage_metric_tokens()}</th>
					</tr>
				</thead>
				<tbody>
					{#each models as model, index (model.key)}
						{@const value = metricValue(model, metric)}
						{@const costUnknown = isCostUnknown(model)}
						<svelte:boundary>
							<tr
								class="relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50"
							>
								<td class="py-2.5 pr-3 text-left text-xs tabular-nums">{index + 1}</td>
								<td class="py-2.5 text-left whitespace-normal">
									<button
										type="button"
										class="flex items-center gap-2 text-left text-foreground outline-none after:absolute after:inset-0"
										aria-label={m.usage_open_model({
											model: model.model,
											agent: agentLabelFor(model.agentId),
										})}
										onclick={() => onOpenModel(model.key)}
									>
										<span
											aria-hidden="true"
											class="size-2 shrink-0 rounded-full"
											style:background-color={usageAgentColor(model.agentId)}
										></span>
										<span class="break-all">{model.model}</span>
									</button>
									{#if value > 0 && peak > 0}
										<div aria-hidden="true" class="mt-1.5 h-0.5 max-w-48">
											<div
												class="h-full rounded-full"
												style:width={`max(0.5rem, ${(value / peak) * 100}%)`}
												style:background-color={usageAgentColor(model.agentId)}
											></div>
										</div>
									{/if}
								</td>
								<td class="py-2.5 pl-6 text-foreground tabular-nums">
									{#if costUnknown}<span class="text-muted-foreground">{m.usage_unpriced()}</span
										>{:else}{formatUsd(model.costUsd)}{/if}
								</td>
								<td class="hidden py-2.5 pl-6 tabular-nums sm:table-cell">
									{#if metric === 'tokens'}{formatPercent(
											model.tokenShare,
										)}{:else if !costUnknown}{formatPercent(model.costShare)}{/if}
								</td>
								<td class="py-2.5 pl-6 tabular-nums">{formatTokens(model.totalTokens)}</td>
							</tr>
							{#snippet failed()}
								<tr class="border-b border-border/50 text-xs text-muted-foreground">
									<td colspan="5" class="py-2.5">{m.usage_row_failed({ name: model.model })}</td>
								</tr>
							{/snippet}
						</svelte:boundary>
					{/each}
				</tbody>
			</table>
		{:else}
			<table class="w-full text-sm whitespace-nowrap" data-usage-day-table>
				<thead>
					<tr class="border-b border-border text-right text-xs text-muted-foreground">
						<th scope="col" class="py-2 text-left font-normal">{m.usage_breakdown_day()}</th>
						{#each report.agents as agent (agent.agentId)}
							<th scope="col" class="py-2 pl-4 font-normal">{agentLabelFor(agent.agentId)}</th>
						{/each}
						<th scope="col" class="py-2 pl-4 font-normal">{m.usage_total()}</th>
						<th scope="col" class="py-2 pl-4 font-normal">
							{metric === 'cost' ? m.usage_metric_tokens() : m.usage_metric_cost()}
						</th>
					</tr>
				</thead>
				<tbody>
					{#each activeDays as day (day.day)}
						<svelte:boundary>
							<tr
								class="border-b border-border/50 text-right tabular-nums transition-colors hover:bg-muted/50"
							>
								<th scope="row" class="py-2 text-left font-normal text-foreground"
									>{formatDayWithYear(day.day)}</th
								>
								{#each report.agents as agent (agent.agentId)}
									{@const point = day.byAgent.get(agent.agentId)}
									<td class="py-2 pl-4 text-muted-foreground">
										{metric === 'cost'
											? formatUsd(point?.costUsd ?? 0)
											: formatTokens(point?.totalTokens ?? 0)}
									</td>
								{/each}
								<td class="py-2 pl-4 text-foreground">
									{metric === 'cost' ? formatUsd(day.costUsd) : formatTokens(day.totalTokens)}
								</td>
								<td class="py-2 pl-4 text-muted-foreground">
									{metric === 'cost' ? formatTokens(day.totalTokens) : formatUsd(day.costUsd)}
								</td>
							</tr>
							{#snippet failed()}
								<tr class="border-b border-border/50 text-xs text-muted-foreground">
									<td colspan={report.agents.length + 3} class="py-2"
										>{m.usage_row_failed({ name: day.day })}</td
									>
								</tr>
							{/snippet}
						</svelte:boundary>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</section>
