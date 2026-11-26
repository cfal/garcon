<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		WORKFLOW_DEFINITION_LIMITS,
		workflowCommandEnvName,
		type WorkflowDefinition,
		type WorkflowStep,
	} from '$shared/workflow-definition';
	import type { JsonValue } from '$shared/json';
	import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';
	import {
		workflowBindingSource,
		workflowSignals,
		workflowSignalSubscription,
	} from '$lib/workflows/definition/workflow-step-options';
	import { createRandomId } from '$lib/utils/random-id';
	import * as m from '$lib/paraglide/messages.js';
	import WorkflowChoicesEditor from './WorkflowChoicesEditor.svelte';
	import WorkflowSignalsEditor from './WorkflowSignalsEditor.svelte';
	import WorkflowStepSettings from './WorkflowStepSettings.svelte';

	let {
		step,
		definition,
		context,
		narrow,
		editing,
		onEdit,
		onDuplicate,
		onInsert,
		onRemove,
		onBranch,
	}: {
		step: WorkflowStep;
		definition: WorkflowDefinition;
		context: WorkflowLaunchContext | null;
		narrow: boolean;
		editing: boolean;
		onEdit: (fields: Readonly<Record<string, JsonValue | undefined>>) => boolean;
		onDuplicate: () => void;
		onInsert: () => void;
		onRemove: () => void;
		onBranch: (signal: string) => void;
	} = $props();

	const index = $derived(definition.steps.findIndex(({ id }) => id === step.id));
	// A CST edit reparses every step; only a change to the authored field resets its local edits.
	const authoredName = $derived(step.name ?? '');
	const authoredInstruction = $derived(step.kind === 'command' ? step.command : step.prompt);
	const authoredMode = $derived.by((): 'root' | 'signal' | 'join' => {
		if (!step.on) return 'root';
		return step.on.kind === 'all' ? 'join' : 'signal';
	});
	const authoredReference = $derived.by(() => {
		const on = step.on;
		const trigger = on?.kind === 'all' ? on.close : on?.signal;
		return trigger ? `${trigger.stepId}.${trigger.signal}` : '';
	});
	const authoredConcurrency = $derived(step.on?.kind === 'each' ? step.on.maxConcurrency : 1);
	const authoredGroups = $derived(JSON.stringify(step.on?.kind === 'all' ? step.on.steps : []));
	const authoredBindings = $derived(JSON.stringify(step.bindings ?? {}));
	let name = $derived(authoredName);
	let instruction = $derived(authoredInstruction);
	let mode = $derived(authoredMode);
	let reference = $derived(authoredReference);
	let concurrency = $derived<number | undefined>(authoredConcurrency);
	let groups = $derived(JSON.parse(authoredGroups) as string[]);
	let bindings = $derived.by(() => {
		const parsed = JSON.parse(authoredBindings) as Record<
			string,
			Parameters<typeof workflowBindingSource>[0]
		>;
		return Object.entries(parsed).map(([name, binding]) => ({
			id: `binding:${name}`,
			name,
			source: workflowBindingSource(binding),
		}));
	});
	let showSettings = $state(false);
	let branchSignal = $state('');
	const available = $derived(
		workflowSignals(
			definition.steps.filter((entry) => entry.id !== step.id && entry.on?.kind !== 'each'),
		),
	);
	const signal = $derived(available.find((entry) => entry.value === reference));
	const groupOptions = $derived(
		definition.steps.filter(
			(entry) =>
				entry.id !== step.id &&
				entry.on?.kind === 'each' &&
				entry.on.signal.stepId === reference.split('.')[0],
		),
	);
	const triggerOptions = $derived(
		mode === 'join'
			? available.filter(
					(entry) =>
						entry.value.endsWith('.turn_completed') &&
						definition.steps.some(
							({ on }) => on?.kind === 'each' && on.signal.stepId === entry.value.split('.')[0],
						),
				)
			: available,
	);
	const branchOptions = $derived(step.on?.kind === 'each' ? [] : workflowSignals([step]));
	const bindingSources = $derived([
		...Object.keys(definition.inputs).map((key) => `inputs.${key}`),
		...(mode === 'join'
			? groupOptions
					.filter(({ id, kind }) => kind !== 'decision' && groups.includes(id))
					.map(({ id }) => `all.${id}`)
			: []),
		...(mode !== 'root' && signal && signal.payload !== 'none'
			? ['signal', ...signal.fields.map((key) => `signal.${key}`)]
			: []),
	]);
	const complete = $derived(
		Boolean(instruction.trim()) &&
			(mode === 'root' || (Boolean(signal) && (mode !== 'join' || groups.length > 0))) &&
			bindings.every(({ name, source }) => name.trim() && source) &&
			new Set(bindings.map(({ name }) => name.trim())).size === bindings.length &&
			(step.kind !== 'command' ||
				new Set(bindings.map(({ name }) => workflowCommandEnvName(name.trim()))).size ===
					bindings.length),
	);

	function applyFields(fields: Readonly<Record<string, JsonValue | undefined>>) {
		if (!editing || index < 0) return false;
		return onEdit(fields);
	}

	function applyStep(event: SubmitEvent) {
		event.preventDefault();
		if (!editing || !complete) return;
		let on: JsonValue | undefined;
		if (mode === 'join') on = { kind: 'all', close: reference, steps: groups };
		else if (mode === 'signal' && signal) on = workflowSignalSubscription(signal, concurrency ?? 1);
		applyFields({
			name: name.trim() || undefined,
			[step.kind === 'command' ? 'command' : 'prompt']: instruction,
			on,
			bindings: bindings.length
				? Object.fromEntries(bindings.map(({ name, source }) => [name.trim(), source]))
				: undefined,
		});
	}
</script>

{#if editing}
	<form class="space-y-3" onsubmit={applyStep}>
		<label class="block space-y-1 text-sm">
			<span>{m.workflow_studio_step_name()}</span>
			<input class="workflow-field" placeholder={step.id} bind:value={name} maxlength="256" />
		</label>
		<label class="block space-y-1 text-sm">
			<span
				>{step.kind === 'command' ? m.workflow_studio_command() : m.workflow_studio_prompt()}</span
			>
			<textarea class="workflow-field min-h-28" required bind:value={instruction}></textarea>
		</label>
		<label class="block space-y-1 text-sm">
			<span>{m.workflow_studio_dependency()}</span>
			<select class="workflow-field" bind:value={mode}>
				<option value="root">{m.workflow_studio_independent()}</option>
				<option value="signal">{m.workflow_studio_on_signal()}</option>
				<option value="join">{m.workflow_studio_join_groups()}</option>
			</select>
		</label>
		{#if mode !== 'root'}
			<label class="block space-y-1 text-sm">
				<span
					>{mode === 'join' ? m.workflow_studio_close_signal() : m.workflow_studio_signal()}</span
				>
				<select class="workflow-field" required bind:value={reference}>
					<option value="">{m.workflow_studio_choose_signal()}</option>
					{#each triggerOptions as entry (entry.value)}<option value={entry.value}
							>{entry.label}</option
						>{/each}
				</select>
			</label>
			{#if mode === 'join' && groupOptions.length}
				<fieldset class="space-y-1">
					<legend class="text-sm">{m.workflow_studio_repeat_groups()}</legend>
					{#each groupOptions as group (group.id)}
						<label class="flex items-center gap-2 wrap-anywhere text-sm">
							<input
								type="checkbox"
								checked={groups.includes(group.id)}
								onchange={(event) =>
									(groups = event.currentTarget.checked
										? [...groups, group.id]
										: groups.filter((id) => id !== group.id))}
							/>
							{group.name ?? group.id}
						</label>
					{/each}
				</fieldset>
			{:else if signal?.delivery === 'many'}
				<label class="block space-y-1 text-sm">
					<span>{m.workflow_studio_concurrency()}</span>
					<input
						class="workflow-field"
						type="number"
						step="1"
						min="1"
						max={WORKFLOW_DEFINITION_LIMITS.repeatConcurrency}
						required
						bind:value={concurrency}
					/>
				</label>
			{/if}
		{/if}
		<fieldset class="space-y-2">
			<legend class="text-sm"
				>{step.kind === 'command'
					? m.workflow_studio_command_bindings()
					: m.workflow_studio_bindings()}</legend
			>
			{#each bindings as binding, index (binding.id)}
				<div class="grid min-w-0 gap-1">
					<input
						class="workflow-field"
						type="text"
						required
						value={binding.name}
						aria-label={m.workflow_studio_binding_name()}
						oninput={(event) => {
							const name = event.currentTarget.value;
							bindings = bindings.map((entry, current) =>
								current === index ? { ...entry, name } : entry,
							);
						}}
					/>
					{#if step.kind === 'command' && binding.name.trim()}
						<p class="font-mono text-xs text-muted-foreground">
							${workflowCommandEnvName(binding.name.trim())}
						</p>
					{/if}
					<select
						class="workflow-field"
						required
						value={binding.source}
						aria-label={m.workflow_studio_binding_source()}
						onchange={(event) => {
							const source = event.currentTarget.value;
							bindings = bindings.map((entry, current) =>
								current === index ? { ...entry, source } : entry,
							);
						}}
					>
						<option value="">{m.workflow_studio_binding_source()}</option>
						{#if binding.source && !bindingSources.includes(binding.source)}<option
								value={binding.source}>{binding.source} · {m.common_unavailable()}</option
							>{/if}
						{#each bindingSources as source (source)}<option value={source}>{source}</option
							>{/each}
					</select>
					<Button
						size="sm"
						variant="ghost"
						class="justify-self-start"
						onclick={() => (bindings = bindings.filter((_, current) => current !== index))}
						>{m.workflow_studio_remove_binding()}</Button
					>
				</div>
			{/each}
			{#if bindingSources.length}
				<Button
					size="sm"
					variant="outline"
					onclick={() => (bindings = [...bindings, { id: createRandomId(), name: '', source: '' }])}
					>{m.workflow_studio_add_binding()}</Button
				>
			{/if}
		</fieldset>
		<Button type="submit" size="sm" disabled={!complete}>{m.workflow_studio_apply_step()}</Button>
	</form>
	<div class="flex flex-wrap gap-2 border-t border-border pt-3">
		<Button
			size="sm"
			variant="outline"
			disabled={definition.steps.length >= WORKFLOW_DEFINITION_LIMITS.steps}
			onclick={onInsert}>{m.workflow_studio_insert_after()}</Button
		>
		<Button
			size="sm"
			variant="outline"
			disabled={definition.steps.length >= WORKFLOW_DEFINITION_LIMITS.steps}
			onclick={onDuplicate}>{m.workflow_studio_duplicate()}</Button
		>
		<Button
			size="sm"
			variant="ghost"
			class="text-destructive"
			disabled={definition.steps.length < 2}
			onclick={onRemove}>{m.workflow_studio_remove_step()}</Button
		>
	</div>
	{#if branchOptions.length}
		<div class="flex flex-wrap items-center gap-2">
			<select
				class="workflow-field flex-1"
				aria-label={m.workflow_studio_branch_signal()}
				bind:value={branchSignal}
			>
				<option value="">{m.workflow_studio_choose_signal()}</option>
				{#each branchOptions as option (option.value)}<option value={option.value}
						>{option.label}</option
					>{/each}
			</select>
			<Button
				size="sm"
				variant="outline"
				disabled={!branchSignal || definition.steps.length >= WORKFLOW_DEFINITION_LIMITS.steps}
				onclick={() => onBranch(branchSignal)}>{m.workflow_studio_branch()}</Button
			>
		</div>
	{/if}
	{#if step.kind !== 'decision'}
		<Button
			size="sm"
			variant="outline"
			aria-expanded={showSettings}
			onclick={() => (showSettings = !showSettings)}>{m.workflow_studio_step_settings()}</Button
		>
		{#if showSettings}
			<WorkflowStepSettings {step} {context} {narrow} disabled={!editing} onApply={applyFields} />
		{/if}
	{/if}
{:else}
	<pre class="whitespace-pre-wrap wrap-anywhere bg-muted p-2 text-sm">{instruction}</pre>
{/if}
{#if editing && step.kind === 'decision'}
	<WorkflowChoicesEditor choices={step.choices} onChange={(choices) => applyFields({ choices })} />
{:else if editing && step.kind === 'agent'}
	<WorkflowSignalsEditor
		signals={step.signals ?? {}}
		onChange={(signals) => applyFields({ signals })}
	/>
{:else if step.kind === 'decision'}
	<div class="space-y-1">
		<h3 class="text-xs font-medium text-muted-foreground">
			{m.workflow_studio_decision_choices()}
		</h3>
		<ul class="text-sm">
			{#each Object.entries(step.choices) as [key, label] (key)}<li class="wrap-anywhere">
					{label} <code class="text-xs">{key}</code>
				</li>{/each}
		</ul>
	</div>
{/if}
