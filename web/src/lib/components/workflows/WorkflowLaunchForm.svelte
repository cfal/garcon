<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import Play from '@lucide/svelte/icons/play';
	import { Button } from '$lib/components/ui/button';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import ProjectPathField from '$lib/components/project-paths/ProjectPathField.svelte';
	import { getExecutors } from '$lib/context';
	import { validateWorkflowLocation } from '$lib/workflows/launch/validate-workflow-location';
	import type { WorkflowDefinition } from '$shared/workflow-definition';
	import type { WorkflowExecutionContext } from '$shared/workflow-runs';
	import type { JsonObject } from '$shared/json';
	import { decodeWorkflowInputs, workflowInputText } from '$lib/workflows/launch/workflow-inputs';
	import {
		workflowLocations,
		type WorkflowLaunchContext,
	} from '$lib/workflows/launch/workflow-locations';
	import * as m from '$lib/paraglide/messages.js';

	let {
		definition,
		context,
		draftRun,
		disabled = false,
		onLaunch,
	}: {
		definition: WorkflowDefinition;
		context: WorkflowLaunchContext | null;
		draftRun: boolean;
		disabled?: boolean;
		onLaunch: (inputs: JsonObject, executionContext: WorkflowExecutionContext) => Promise<void>;
	} = $props();

	const executors = getExecutors();
	const id = $props.id();
	let fields = $state<Record<string, string>>({});
	let executorId = $state(untrack(() => context?.executorId ?? 'local'));
	let paths = $state<Record<string, string>>(
		untrack(() => (context ? { [context.executorId]: context.cwd } : {})),
	);
	let pathPicker = $state<string | null>(null);
	let checking = $state(false);
	let submitted = $state(false);
	let pathError = $state<string | null>(null);
	let width = $state(0);
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});
	const plan = $derived(workflowLocations(definition.steps, executorId, paths));
	const values = $derived(decodeWorkflowInputs(definition.inputs, fields));
	const hasInheritedExecutor = $derived(
		definition.steps.some((step) => step.kind !== 'decision' && !step.executorId),
	);
	const locked = $derived(disabled || checking);
	const errorLabels = {
		required: m.workflow_studio_required_input,
		number: m.workflow_studio_number_input,
		boolean: m.workflow_studio_required_input,
		json: m.workflow_studio_json_input,
	};

	async function launch(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (locked) return;
		submitted = true;
		pathError = null;
		const decoded = values;
		const captured = plan;
		const selectedDefinition = definition;
		if (Object.keys(decoded.errors).length) return;
		if (captured.missingFolders.length) {
			pathError = m.workflow_studio_missing_folder({
				executor: executors.label(captured.missingFolders[0]),
			});
			return;
		}
		checking = true;
		try {
			const checked = new Set<string>();
			for (const { location } of captured.locations) {
				const key = JSON.stringify(location);
				if (checked.has(key)) continue;
				checked.add(key);
				pathError = await validateWorkflowLocation(location, executors);
				if (pathError) return;
			}
			if (mounted && selectedDefinition === definition && !disabled) {
				await onLaunch(decoded.inputs, captured.executionContext);
			}
		} catch (error) {
			pathError = error instanceof Error ? error.message : m.workflow_studio_action_failed();
		} finally {
			checking = false;
		}
	}
</script>

<form bind:clientWidth={width} class="space-y-4" onsubmit={launch}>
	{#if Object.keys(definition.inputs).length}
		<fieldset disabled={locked} class="space-y-3">
			<legend class="text-sm font-semibold">{m.workflow_studio_run_inputs()}</legend>
			{#each Object.entries(definition.inputs) as [key, input] (key)}
				<svelte:boundary>
					{@const value = Object.hasOwn(fields, key)
						? fields[key]
						: workflowInputText(input.default, input.type)}
					<label class="block space-y-1 text-sm">
						<span class="wrap-anywhere font-medium">{key}</span>
						{#if input.description}<span class="block wrap-anywhere text-xs text-muted-foreground"
								>{input.description}</span
							>{/if}
						{#if input.type === 'boolean'}
							<select
								class="workflow-field"
								{value}
								onchange={(event) => (fields = { ...fields, [key]: event.currentTarget.value })}
							>
								<option value="" disabled>{m.workflow_studio_choose_boolean()}</option>
								<option value="true">{m.workflow_studio_true()}</option>
								<option value="false">{m.workflow_studio_false()}</option>
							</select>
						{:else if input.type === 'json'}
							<textarea
								class="workflow-field min-h-24 font-mono"
								spellcheck={false}
								{value}
								oninput={(event) => (fields = { ...fields, [key]: event.currentTarget.value })}
							></textarea>
						{:else}
							<input
								class="workflow-field"
								type={input.type === 'number' ? 'number' : 'text'}
								step={input.type === 'number' ? 'any' : undefined}
								{value}
								oninput={(event) => (fields = { ...fields, [key]: event.currentTarget.value })}
							/>
						{/if}
						{#if submitted && Object.hasOwn(values.errors, key)}
							<span class="block text-xs text-destructive">{errorLabels[values.errors[key]]()}</span
							>
						{/if}
					</label>
					{#snippet failed()}<p class="text-sm text-destructive">
							{m.workflow_studio_input_unavailable()}
						</p>{/snippet}
				</svelte:boundary>
			{/each}
		</fieldset>
	{/if}
	{#if plan.locations.length}
		<fieldset disabled={locked} class="space-y-3">
			<legend class="text-sm font-semibold">{m.workflow_studio_locations()}</legend>
			{#if hasInheritedExecutor}
				<div class="flex flex-wrap items-center gap-2 text-sm">
					<span>{m.workflow_studio_launch_executor()}: {executors.label(executorId)}</span>
					<ExecutorSelector
						{executors}
						{executorId}
						service="agents"
						disabled={locked}
						onSelect={(id) => {
							executorId = id;
							pathPicker = null;
						}}
					/>
				</div>
			{/if}
			{#each plan.requiredFolders as executor (executor)}
				<svelte:boundary>
					<div class="space-y-1">
						<label for={`${id}-${executor}`} class="block wrap-anywhere text-sm"
							>{m.workflow_studio_folder_for({ executor: executors.label(executor) })}</label
						>
						<ProjectPathField
							id={`${id}-${executor}`}
							value={paths[executor] ?? ''}
							oninput={(event) => (paths = { ...paths, [executor]: event.currentTarget.value })}
							browser={{
								open: pathPicker === executor,
								executorId: executor,
								executorContextKey: executors.pathContextKey(executor),
								currentPath: paths[executor] ?? executors.get(executor)?.projectBasePath ?? '',
								basePath: executors.get(executor)?.projectBasePath ?? '',
								isMobile: width < 600,
								onSelect: (path) => (paths = { ...paths, [executor]: path }),
								onClose: () => (pathPicker = null),
								button: {
									label: m.workflow_studio_browse_folder(),
									disabled: !executors.filesAvailable(executor),
									onclick: () => (pathPicker = pathPicker === executor ? null : executor),
								},
							}}
						/>
					</div>
					{#snippet failed()}<p class="text-sm text-destructive">
							{m.workflow_studio_input_unavailable()}
						</p>{/snippet}
				</svelte:boundary>
			{/each}
		</fieldset>
		<ul
			class="divide-y divide-border border-y border-border text-sm"
			aria-label={m.workflow_studio_effective_locations()}
		>
			{#each plan.locations as { step, location } (step.id)}
				<svelte:boundary>
					<li class="space-y-1 py-2">
						<p class="wrap-anywhere font-medium">{step.name ?? step.id}</p>
						<p class="wrap-anywhere text-xs text-muted-foreground">
							{executors.label(location.executorId)} · {location.projectPath ||
								m.workflow_studio_missing_project()}
						</p>
						{#if step.kind === 'agent'}
							<p class="wrap-anywhere text-xs text-muted-foreground">
								{[
									step.agentId,
									step.model,
									step.apiProviderId,
									step.permissionMode,
									step.thinkingMode,
								]
									.filter(Boolean)
									.join(' · ') || m.workflow_studio_agent_defaults()}
							</p>
						{:else if step.kind === 'command' && step.shell}
							<p class="wrap-anywhere text-xs text-muted-foreground">{step.shell}</p>
						{/if}
						{#if !executors.isReady(location.executorId)}<p
								class="text-xs text-status-warning-foreground"
							>
								{m.workflow_studio_waiting_executor()}
							</p>{/if}
					</li>
					{#snippet failed()}<li class="py-2 text-sm text-destructive">
							{m.workflow_studio_step_unavailable()}
						</li>{/snippet}
				</svelte:boundary>
			{/each}
		</ul>
	{/if}
	{#if pathError}<p role="alert" class="wrap-anywhere text-sm text-destructive">{pathError}</p>{/if}
	<Button type="submit" disabled={locked}>
		<Play class="size-4" />
		{checking
			? m.workflow_studio_starting()
			: draftRun
				? m.workflow_studio_test_run()
				: m.workflow_studio_start()}
	</Button>
</form>
