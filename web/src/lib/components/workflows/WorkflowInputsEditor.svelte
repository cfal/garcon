<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		WORKFLOW_VALUE_TYPES,
		type WorkflowInput,
		type WorkflowValueType,
	} from '$shared/workflow-definition';
	import type { JsonValue } from '$shared/json';
	import { decodeWorkflowInputs, workflowInputText } from '$lib/workflows/launch/workflow-inputs';
	import { isNewWorkflowField } from '$lib/workflows/definition/workflow-named-fields';
	import * as m from '$lib/paraglide/messages.js';
	import WorkflowNamedEntries from './WorkflowNamedEntries.svelte';

	let {
		inputs,
		onChange,
	}: {
		inputs: Readonly<Record<string, WorkflowInput>>;
		onChange: (name: string, input: JsonValue | undefined) => boolean;
	} = $props();

	let active = $state<string | null | undefined>();
	let name = $state('');
	let valueType = $state<WorkflowValueType>('string');
	let description = $state('');
	let hasDefault = $state(false);
	let defaultValue = $state('');
	let problem = $state<string | null>(null);
	const entries = $derived(
		Object.entries(inputs).map(([id, input]) => ({
			id,
			summary: input.description ? `${input.type} · ${input.description}` : input.type,
		})),
	);

	function edit(key: string | null) {
		const input = key ? inputs[key] : undefined;
		name = key ?? '';
		valueType = input?.type ?? 'string';
		description = input?.description ?? '';
		hasDefault = input?.default !== undefined;
		defaultValue = input ? workflowInputText(input.default, input.type) : '';
		problem = null;
		active = key;
	}

	function apply(event: SubmitEvent) {
		event.preventDefault();
		const key = active ?? name.trim();
		problem = null;
		if (active === null && !isNewWorkflowField(key, inputs)) {
			problem = m.workflow_studio_unique_key();
			return;
		}
		const value = { type: valueType, ...(description.trim() ? { description } : {}) };
		const decoded = hasDefault
			? decodeWorkflowInputs({ [key]: value }, { [key]: defaultValue })
			: null;
		if (decoded && Object.hasOwn(decoded.errors, key)) {
			problem = m.workflow_studio_bad_default();
			return;
		}
		if (onChange(key, decoded ? { ...value, default: decoded.inputs[key] } : value))
			active = undefined;
	}
</script>

<WorkflowNamedEntries
	title={m.workflow_studio_input_schema()}
	add={m.workflow_studio_add_input()}
	{entries}
	onEdit={edit}
	onRemove={(key) => {
		if (onChange(key, undefined)) active = undefined;
	}}
>
	{#if active !== undefined}
		<form class="space-y-2 border-l border-border pl-2" onsubmit={apply}>
			<label class="block space-y-1">
				<span>{m.workflow_studio_input_name()}</span>
				<input
					class="workflow-field"
					required
					maxlength="128"
					readonly={active !== null}
					bind:value={name}
				/>
			</label>
			<label class="block space-y-1">
				<span>{m.workflow_studio_value_type()}</span>
				<select
					class="workflow-field"
					value={valueType}
					onchange={(event) => {
						valueType =
							WORKFLOW_VALUE_TYPES.find((type) => type === event.currentTarget.value) ?? 'string';
						defaultValue = '';
					}}
				>
					{#each WORKFLOW_VALUE_TYPES as type (type)}<option value={type}>{type}</option>{/each}
				</select>
			</label>
			<label class="block space-y-1">
				<span>{m.workflow_studio_field_description()}</span>
				<input class="workflow-field" bind:value={description} />
			</label>
			<label class="flex items-center gap-2">
				<input type="checkbox" bind:checked={hasDefault} />
				{m.workflow_studio_has_default()}
			</label>
			{#if hasDefault}
				<label class="block space-y-1">
					<span>{m.workflow_studio_default_value()}</span>
					{#if valueType === 'boolean'}
						<select
							class="workflow-field"
							value={defaultValue}
							onchange={(event) => (defaultValue = event.currentTarget.value)}
						>
							<option value="" disabled>{m.workflow_studio_choose_boolean()}</option>
							<option value="true">{m.workflow_studio_true()}</option>
							<option value="false">{m.workflow_studio_false()}</option>
						</select>
					{:else if valueType === 'number'}
						<input
							type="number"
							class="workflow-field"
							step="any"
							value={defaultValue}
							oninput={(event) => (defaultValue = event.currentTarget.value)}
						/>
					{:else}
						<textarea class="workflow-field min-h-16" bind:value={defaultValue}></textarea>
					{/if}
				</label>
			{/if}
			{#if problem}<p role="alert" class="text-xs text-destructive">{problem}</p>{/if}
			<div class="flex flex-wrap gap-2">
				<Button type="submit" size="sm">{m.workflow_studio_apply_input()}</Button>
				<Button size="sm" variant="ghost" onclick={() => (active = undefined)}
					>{m.common_cancel()}</Button
				>
			</div>
		</form>
	{/if}
</WorkflowNamedEntries>
