<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import Archive from '@lucide/svelte/icons/archive';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import List from '@lucide/svelte/icons/list';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		addWorkflowItem,
		addWorkflowStep,
		archiveWorkflowRun,
		decideWorkflow,
		getWorkflowRun,
		retryWorkflowStep,
	} from '$lib/api/workflows';
	import * as m from '$lib/paraglide/messages.js';
	import { lazyRenderer } from '$lib/utils/lazy-renderer';
	import { createRandomId } from '$lib/utils/random-id';
	import type {
		WorkflowAddItemRequest,
		WorkflowAddStepRequest,
		WorkflowInstanceStatus,
	} from '$shared/workflow-runs';
	import { workflowEdges } from '$lib/workflows/definition/workflow-graph';
	import { WorkflowRunController } from '$lib/workflows/run/workflow-run-controller.svelte';
	import {
		WORKFLOW_INSTANCE_STATUSES,
		manualWorkflowEdges,
		matchingWorkflowInstances,
		workflowRunFinished,
		workflowRunHasLiveAttempt,
	} from '$lib/workflows/run/workflow-run-projection';
	import WorkflowRunAddItem from './WorkflowRunAddItem.svelte';
	import WorkflowRunAddStep from './WorkflowRunAddStep.svelte';
	import WorkflowRunInspector from './WorkflowRunInspector.svelte';
	import WorkflowSplitView from './WorkflowSplitView.svelte';
	import WorkflowStepList from './WorkflowStepList.svelte';
	import { workflowStatusLabel } from './workflow-labels';

	let {
		runId,
		onOpenChat,
		visible,
	}: {
		runId: string;
		onOpenChat: (chatId: string) => void;
		visible: boolean;
	} = $props();

	const graph = lazyRenderer(() => import('./WorkflowGraph.svelte'));
	const controller = new WorkflowRunController(
		untrack(() => runId),
		getWorkflowRun,
	);
	const run = $derived(controller.detail);
	let width = $state(0);
	let shell = $state<HTMLElement>();
	let heading = $state<HTMLHeadingElement>();
	let listMode = $state<'graph' | 'list'>('list');
	let detailOpen = $state(false);
	let stepId = $state<string | null>(null);
	let instanceId = $state<string | null>(null);
	let query = $state('');
	let status = $state<WorkflowInstanceStatus | ''>('');
	let amendment = $state<
		{ kind: 'step'; evidence?: string } | { kind: 'item'; stepId: string } | null
	>(null);
	let archiveOpen = $state(false);
	const selected = $derived(run?.steps.find(({ step }) => stepId === step.id));
	const instances = $derived(matchingWorkflowInstances(selected?.instances ?? [], query, status));
	const instance = $derived(
		selected?.instances.find(({ id }) => id === instanceId) ?? instances[0] ?? null,
	);
	const amendTarget = $derived(
		amendment?.kind === 'item'
			? run?.steps.find(({ step }) => amendment?.kind === 'item' && step.id === amendment.stepId)
			: null,
	);
	const disabled = $derived(
		controller.mutating || controller.actionUnconfirmed || run?.status === 'archived',
	);
	const canArchive = $derived(run && run.status !== 'archived' && !workflowRunHasLiveAttempt(run));
	const nodes = $derived(
		run?.steps.map(({ step, instances, waitingReason }) => ({
			id: step.id,
			title: step.name ?? step.id,
			kind: step.kind,
			detail:
				step.on?.kind === 'each'
					? m.workflow_studio_instance_count({ count: instances.length })
					: instances[0]
						? workflowStatusLabel(instances[0].status)
						: (waitingReason ?? undefined),
		})) ?? [],
	);
	const edges = $derived(
		run ? [...workflowEdges(run.steps.map(({ step }) => step)), ...manualWorkflowEdges(run)] : [],
	);

	$effect(() => {
		if (visible) return untrack(() => controller.observe());
	});
	onDestroy(() => controller.dispose());

	function openDetail() {
		detailOpen = true;
		if (width < 688) void tick().then(() => heading?.focus());
	}

	function selectStep(id: string) {
		if (id !== stepId) {
			stepId = id;
			instanceId = null;
			query = '';
			status = '';
		}
		amendment = null;
		openDetail();
	}

	function back() {
		detailOpen = false;
		amendment = null;
		void tick().then(() => {
			const buttons = shell?.querySelectorAll<HTMLButtonElement>('[data-workflow-step]');
			const button =
				buttons && Array.from(buttons).find((entry) => entry.dataset.workflowStep === stepId);
			(button ?? shell?.querySelector<HTMLButtonElement>('[data-workflow-view]'))?.focus();
		});
	}

	function addStep(evidence?: string) {
		if (disabled || !run || workflowRunFinished(run)) return;
		amendment = { kind: 'step', evidence };
		openDetail();
	}

	async function submitAmendment(action: WorkflowAddItemRequest | WorkflowAddStepRequest) {
		const applied = await controller.mutate(() =>
			'stepId' in action ? addWorkflowItem(action) : addWorkflowStep(action),
		);
		if (applied) amendment = null;
	}

	function decide(instanceId: string, choice: string) {
		const request = { runId, instanceId, choice, operationId: createRandomId() };
		void controller.mutate(() => decideWorkflow(request));
	}

	function retry(instanceId: string) {
		const request = { runId, instanceId, operationId: createRandomId() };
		void controller.mutate(() => retryWorkflowStep(request));
	}

	async function retryAction() {
		if (await controller.retryUnconfirmed()) amendment = null;
	}

	async function archiveRun() {
		if (!canArchive || disabled) return;
		archiveOpen = false;
		const request = { runId, operationId: createRandomId() };
		if (await controller.mutate(() => archiveWorkflowRun(request))) amendment = null;
	}
</script>

<section
	class="flex h-full min-h-0 min-w-0 flex-col"
	aria-label={m.workflow_studio_run_viewer()}
	bind:this={shell}
	bind:clientWidth={width}
>
	<header class="grid shrink-0 gap-2 border-b border-border bg-card px-3 py-2 sm:px-4">
		<div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
			<div class="min-w-0">
				<h2 class="wrap-anywhere text-base font-semibold">
					{run?.name ?? m.workflow_studio_run_viewer()}
				</h2>
				{#if run}
					<p class="wrap-anywhere text-xs text-muted-foreground">
						{run.kind === 'test'
							? m.workflow_studio_test_run()
							: m.workflow_studio_revision({ revision: run.revision ?? '' })} · {workflowStatusLabel(
							run.status,
						)}
					</p>
					{#if run.archive}
						<p class="wrap-anywhere text-xs text-muted-foreground">
							{m.workflow_studio_archived_by({
								name: run.archive.actor.name,
								date: new Date(run.archive.createdAt).toLocaleString(),
							})}
						</p>
					{/if}
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-1">
				{#if run && !workflowRunFinished(run)}
					<Button size="sm" variant="outline" {disabled} onclick={() => addStep()}
						><Plus class="size-4" /> {m.workflow_studio_add_step()}</Button
					>
				{/if}
				{#if canArchive}
					<Button size="sm" variant="outline" {disabled} onclick={() => (archiveOpen = true)}
						><Archive class="size-4" /> {m.workflow_studio_archive_run()}</Button
					>
				{/if}
				<Button
					size="icon-sm"
					variant="ghost"
					disabled={controller.mutating}
					title={m.workflow_studio_refresh()}
					aria-label={m.workflow_studio_refresh()}
					onclick={() => void controller.refresh()}><RefreshCw class="size-4" /></Button
				>
			</div>
		</div>
	</header>
	{#if controller.readError}
		<p
			role="status"
			class="shrink-0 wrap-anywhere border-b border-border px-3 py-2 text-sm text-destructive"
		>
			{controller.readError instanceof Error
				? controller.readError.message
				: m.workflow_studio_read_failed()}
		</p>
	{/if}
	{#if controller.actionError}
		<div class="shrink-0 space-y-2 border-b border-border px-3 py-2">
			<p role="alert" class="wrap-anywhere text-sm text-destructive">
				{controller.actionUnconfirmed
					? m.workflow_studio_action_unconfirmed()
					: controller.actionError instanceof Error
						? controller.actionError.message
						: m.workflow_studio_action_failed()}
			</p>
			{#if controller.actionUnconfirmed}
				<Button size="sm" variant="outline" disabled={controller.mutating} onclick={retryAction}
					>{m.workflow_studio_retry_action()}</Button
				>
			{/if}
		</div>
	{/if}
	{#if !run && !controller.readError}
		<p role="status" class="p-4 text-sm text-muted-foreground">{m.workflow_studio_loading_run()}</p>
	{:else if run}
		<WorkflowSplitView showingDetail={detailOpen}>
			{#snippet overview()}
				<div class="flex h-full min-h-0 flex-col">
					<div class="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2">
						<Button
							size="sm"
							data-workflow-view
							variant={listMode === 'list' ? 'secondary' : 'ghost'}
							aria-pressed={listMode === 'list'}
							onclick={() => (listMode = 'list')}
							><List class="size-4" /> {m.workflow_studio_list()}</Button
						>
						<Button
							size="sm"
							variant={listMode === 'graph' ? 'secondary' : 'ghost'}
							aria-pressed={listMode === 'graph'}
							onclick={() => (listMode = 'graph')}
							><WorkflowIcon class="size-4" /> {m.workflow_studio_graph()}</Button
						>
					</div>
					{#if listMode === 'graph' && visible}
						<div class="min-h-60 flex-1">
							{#await graph()}
								<p role="status" class="p-4 text-sm text-muted-foreground">
									{m.workflow_studio_loading_graph()}
								</p>
							{:then Graph}
								<Graph steps={nodes} connections={edges} selected={stepId} onSelect={selectStep} />
							{:catch}
								<p role="alert" class="p-4 text-sm text-destructive">
									{m.workflow_studio_graph_failed()}
								</p>
							{/await}
						</div>
					{:else if listMode === 'list'}
						<WorkflowStepList steps={nodes} {edges} selected={stepId} onSelect={selectStep} />
						<details class="shrink-0 border-t border-border px-4 py-3 text-sm">
							<summary class="cursor-pointer">{m.workflow_studio_run_inputs()}</summary>
							<pre
								class="mt-2 whitespace-pre-wrap wrap-anywhere bg-muted p-2 text-xs">{JSON.stringify(
									run.inputs,
									null,
									2,
								)}</pre>
						</details>
						{#if run.amendments.length}
							<details class="shrink-0 border-t border-border px-4 py-3 text-sm">
								<summary class="cursor-pointer">{m.workflow_studio_live_additions()}</summary>
								<ul class="mt-2 space-y-1">
									{#each run.amendments as entry (entry.operationId)}
										<svelte:boundary>
											<li class="wrap-anywhere text-xs">
												{entry.stepId} · {m.workflow_studio_recorded_by({ name: entry.actor.name })}
											</li>
											{#snippet failed()}<li class="text-xs text-destructive">
													{m.workflow_studio_evidence_unavailable()}
												</li>{/snippet}
										</svelte:boundary>
									{/each}
								</ul>
							</details>
						{/if}
					{/if}
				</div>
			{/snippet}
			{#snippet inspector()}
				<div class="@container/detail px-3 py-3 sm:px-4">
					<div class="mb-3 flex flex-wrap items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							onclick={back}
							class="@min-[43rem]/workflow-split:hidden"
						>
							<ArrowLeft class="size-4" />
							{m.workflow_studio_back_to_steps()}
						</Button>
						<h2
							bind:this={heading}
							tabindex="-1"
							class="wrap-anywhere text-sm font-semibold outline-none"
						>
							{amendment
								? m.workflow_studio_live_additions()
								: (selected?.step.name ?? selected?.step.id ?? m.workflow_studio_step_details())}
						</h2>
					</div>
					{#if amendment?.kind === 'step' && !workflowRunFinished(run)}
						{#key amendment}
							<WorkflowRunAddStep
								{run}
								initialEvidence={amendment.evidence}
								{disabled}
								onSubmit={submitAmendment}
								onCancel={() => (amendment = null)}
							/>
						{/key}
					{:else if amendment?.kind === 'item' && amendTarget && !workflowRunFinished(run)}
						<WorkflowRunAddItem
							{run}
							target={amendTarget}
							{disabled}
							onSubmit={submitAmendment}
							onCancel={() => (amendment = null)}
						/>
					{:else if selected}
						{#if selected.step.on?.kind === 'each' && selected.instances.length}
							<div class="mb-3 space-y-2">
								<div class="grid gap-2 @min-[23rem]/detail:grid-cols-2">
									<input
										class="workflow-field"
										type="search"
										placeholder={m.workflow_studio_filter_instances()}
										aria-label={m.workflow_studio_filter_instances()}
										bind:value={query}
										oninput={() => (instanceId = null)}
									/>
									<select
										class="workflow-field"
										aria-label={m.workflow_studio_instance_status()}
										bind:value={status}
										onchange={() => (instanceId = null)}
									>
										<option value="">{m.workflow_studio_all_statuses()}</option>
										{#each WORKFLOW_INSTANCE_STATUSES as option (option)}<option value={option}
												>{workflowStatusLabel(option)}</option
											>{/each}
									</select>
								</div>
								<select
									class="workflow-field"
									aria-label={m.workflow_studio_instance()}
									value={instance?.id ?? ''}
									onchange={(event) => (instanceId = event.currentTarget.value)}
								>
									{#if instance && !instances.some(({ id }) => id === instance.id)}
										<option value={instance.id}
											>{instance.key ?? instance.id} · {workflowStatusLabel(
												instance.status,
											)}</option
										>
									{/if}
									{#each instances as item (item.id)}
										<option value={item.id}
											>{item.key ?? item.id} · {workflowStatusLabel(item.status)}</option
										>
									{:else}
										<option value="" disabled>{m.workflow_studio_no_matching_instances()}</option>
									{/each}
								</select>
							</div>
						{/if}
						<WorkflowRunInspector
							{run}
							step={selected}
							{instance}
							{disabled}
							{onOpenChat}
							onDecide={decide}
							onRetry={retry}
							onAddFromEvidence={addStep}
							onAddItem={() => {
								if (!selected) return;
								amendment = { kind: 'item', stepId: selected.step.id };
							}}
						/>
					{:else}
						<p class="text-sm text-muted-foreground">{m.workflow_studio_select_step()}</p>
					{/if}
				</div>
			{/snippet}
		</WorkflowSplitView>
	{/if}
</section>

{#if archiveOpen}
	<Dialog.Root
		open
		onOpenChange={(open) => {
			if (!open) archiveOpen = false;
		}}
	>
		<Dialog.Content>
			<Dialog.Header>
				<Dialog.Title>{m.workflow_studio_archive_run()}</Dialog.Title>
				<Dialog.Description>{m.workflow_studio_archive_confirm()}</Dialog.Description>
			</Dialog.Header>
			{#if !canArchive}
				<p role="status" class="text-sm text-muted-foreground">
					{m.workflow_studio_archive_unavailable()}
				</p>
			{/if}
			<div class="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" onclick={() => (archiveOpen = false)}>{m.common_cancel()}</Button>
				<Button disabled={!canArchive || disabled} onclick={archiveRun}
					>{m.workflow_studio_archive_run()}</Button
				>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
