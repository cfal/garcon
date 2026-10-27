<script lang="ts">
	import ChartSpline from '@lucide/svelte/icons/chart-spline';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as m from '$lib/paraglide/messages.js';
	import { getExecutors } from '$lib/context';
	import { agentLabelFor } from '$lib/agents/agent-labels';
	import { USAGE_WINDOW_DAYS } from '$shared/usage';
	import type { UsageController } from '$lib/usage/usage-controller.svelte';
	import { formatDayWithYear } from '$lib/usage/usage-format';
	import type { PresentationHostId } from '$lib/workspace/surface-types';
	import { cn } from '$lib/utils/cn';
	import UsageBreakdown from './UsageBreakdown.svelte';
	import UsageModelDialog from './UsageModelDialog.svelte';
	import UsageOverview from './UsageOverview.svelte';
	import UsageSegmented from './UsageSegmented.svelte';
	import UsageTotals from './UsageTotals.svelte';

	interface Props {
		controller: UsageController;
		presentation: PresentationHostId;
	}

	let { controller, presentation }: Props = $props();

	const executors = getExecutors();
	const titleId = $derived(`usage-title-${presentation.replace(/[^a-zA-Z0-9_-]/g, '-')}`);
	// A failed read for a new executor or window must not leave the previous selection's
	// numbers on screen under it.
	const shownSummary = $derived(controller.stale && controller.error ? null : controller.summary);
	const report = $derived(shownSummary ? controller.report : null);
	const dimmed = $derived(controller.stale || (controller.loading && report !== null));
	const windowOptions = $derived(
		USAGE_WINDOW_DAYS.map((days) => ({ value: days, label: m.usage_window_days({ days }) })),
	);
	const metricOptions = $derived([
		{ value: 'cost' as const, label: m.usage_metric_cost() },
		{ value: 'tokens' as const, label: m.usage_metric_tokens() },
	]);
	const missingAgents = $derived(
		shownSummary?.agents
			.filter((agent) => agent.status === 'missing')
			.map((agent) => agentLabelFor(agent.agentId)) ?? [],
	);
	// An empty window with a failed read is unknown usage, not zero usage.
	const readFailed = $derived(report?.issues.some((issue) => issue.status === 'failed') ?? false);
</script>

<section
	class="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
	aria-labelledby={titleId}
	aria-busy={controller.loading}
	data-usage-panel
	data-presentation={presentation}
>
	<header class="shrink-0 border-b border-border bg-card px-3 py-3 sm:px-4">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex min-w-0 items-start gap-2.5">
				<div class="mt-0.5 rounded-md bg-accent p-1.5 text-accent-foreground">
					<ChartSpline class="size-4" aria-hidden="true" />
				</div>
				<div class="min-w-0">
					<h1 id={titleId} class="text-base font-semibold">{m.workspace_surface_usage()}</h1>
					<p class="text-xs text-muted-foreground">
						{#if shownSummary}
							{m.usage_window_range({
								since: formatDayWithYear(shownSummary.sinceDay),
								until: formatDayWithYear(shownSummary.untilDay),
							})}
						{:else}
							{m.usage_description()}
						{/if}
					</p>
				</div>
			</div>

			<div class="flex flex-wrap items-center gap-1.5">
				{#if executors.hasRemoteExecutors}
					<Select.Root
						type="single"
						value={controller.executorId}
						onValueChange={(value) => {
							if (value) controller.selectExecutor(value);
						}}
					>
						<Select.Trigger class="h-7 max-w-40 text-xs" size="sm" aria-label={m.usage_executor()}>
							<span class="truncate">{executors.label(controller.executorId)}</span>
						</Select.Trigger>
						<Select.Content>
							{#each executors.executors as executor (executor.id)}
								<Select.Item value={executor.id} label={executor.label}
									>{executor.label}</Select.Item
								>
							{/each}
						</Select.Content>
					</Select.Root>
				{/if}
				<UsageSegmented
					label={m.usage_window()}
					options={windowOptions}
					value={controller.windowDays}
					onChange={(days) => controller.setWindowDays(days)}
				/>
				<UsageSegmented
					label={m.usage_metric()}
					options={metricOptions}
					value={controller.metric}
					onChange={(metric) => controller.setMetric(metric)}
				/>
				<button
					type="button"
					class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					aria-label={m.usage_refresh()}
					disabled={controller.loading}
					onclick={() => void controller.refresh()}
				>
					<RefreshCw
						class={cn('size-3.5', controller.loading && 'animate-spin')}
						aria-hidden="true"
					/>
				</button>
			</div>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6">
			{#if controller.error}
				<div
					role="alert"
					class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<div class="min-w-0 flex-1">
						<p>{m.usage_load_failed()}</p>
						<p class="text-xs opacity-80">{controller.error}</p>
					</div>
					<button
						type="button"
						class="shrink-0 rounded px-2 py-0.5 text-xs font-medium hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onclick={() => void controller.refresh()}
					>
						{m.usage_retry()}
					</button>
				</div>
			{/if}

			{#if report}
				{#each report.issues as issue (issue.agentId)}
					<svelte:boundary>
						<p
							class="flex items-start gap-2 text-xs text-muted-foreground"
							data-usage-issue={issue.agentId}
						>
							<CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
							{issue.status === 'failed'
								? m.usage_issue_failed({
										agent: agentLabelFor(issue.agentId),
										message: issue.message ?? '',
									})
								: m.usage_issue_partial({ agent: agentLabelFor(issue.agentId) })}
						</p>
						{#snippet failed()}
							<p class="text-xs text-muted-foreground">
								{m.usage_row_failed({ name: agentLabelFor(issue.agentId) })}
							</p>
						{/snippet}
					</svelte:boundary>
				{/each}
			{/if}

			{#if !report}
				{#if controller.loading || !controller.error}
					<div class="flex flex-col gap-6" aria-hidden="true" data-usage-skeleton>
						<div class="grid gap-6 lg:grid-cols-[17rem_1fr]">
							<div class="flex flex-col gap-4">
								<div class="h-10 w-40 animate-pulse rounded bg-muted"></div>
								<div class="h-4 w-32 animate-pulse rounded bg-muted"></div>
								<div class="h-12 animate-pulse rounded bg-muted"></div>
								<div class="h-12 animate-pulse rounded bg-muted"></div>
							</div>
							<div class="h-60 animate-pulse rounded bg-muted"></div>
						</div>
						<div class="h-24 animate-pulse rounded bg-muted"></div>
					</div>
					<p class="sr-only" role="status">{m.usage_loading()}</p>
				{/if}
			{:else if report.agents.length === 0}
				<div class="flex flex-col items-center gap-2 py-16 text-center" data-usage-empty>
					<ChartSpline class="size-6 text-muted-foreground" aria-hidden="true" />
					<p class="text-sm text-foreground">
						{readFailed ? m.usage_empty_failed() : m.usage_empty()}
					</p>
					{#if !readFailed}
						<p class="max-w-md text-xs text-muted-foreground">
							{missingAgents.length > 0
								? m.usage_empty_missing({ agents: missingAgents.join(', ') })
								: m.usage_empty_hint()}
						</p>
					{/if}
				</div>
			{:else}
				<UsageOverview {report} metric={controller.metric} {dimmed} />
				<UsageTotals {report} metric={controller.metric} {dimmed} />
				<UsageBreakdown
					{report}
					metric={controller.metric}
					breakdown={controller.breakdown}
					{dimmed}
					onBreakdownChange={(breakdown) => controller.setBreakdown(breakdown)}
					onOpenModel={(key) => controller.openModel(key)}
				/>
				{#if report.pricingAsOf}
					<p class="text-xs text-muted-foreground">
						{m.usage_pricing_note({ date: formatDayWithYear(report.pricingAsOf) })}
					</p>
				{/if}
			{/if}
		</div>
	</div>
</section>

{#if controller.selectedModel && report}
	<UsageModelDialog
		model={controller.selectedModel}
		days={report.days}
		metric={controller.metric}
		onClose={() => controller.closeModel()}
	/>
{/if}
