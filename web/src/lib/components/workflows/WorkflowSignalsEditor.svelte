<script lang="ts">
	import { onDestroy } from 'svelte';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import {
		WORKFLOW_VALUE_TYPES,
		type WorkflowSignalDefinition,
		type WorkflowValueType,
	} from '$shared/workflow-definition';
	import { createRandomId } from '$lib/utils/random-id';
	import { isNewWorkflowField } from '$lib/workflows/definition/workflow-named-fields';
	import * as m from '$lib/paraglide/messages.js';
	import WorkflowNamedEntries from './WorkflowNamedEntries.svelte';

	let {
		signals,
		onPendingChange,
		onChange,
	}: {
		signals: Readonly<Record<string, WorkflowSignalDefinition>>;
		onPendingChange?: (pending: boolean) => void;
		onChange: (signals: Readonly<Record<string, WorkflowSignalDefinition>> | undefined) => boolean;
	} = $props();

	const payloads = ['none', 'text', 'json'] as const;
	const labels = {
		none: m.workflow_studio_signal_none,
		text: m.workflow_studio_signal_text,
		json: m.workflow_studio_signal_json,
	};
	let active = $state<string | null | undefined>();
	let name = $state('');
	let payload = $state<WorkflowSignalDefinition['payload']>('none');
	let keyed = $state(false);
	let repeatKey = $state('');
	let fields = $state<{ id: string; name: string; type: WorkflowValueType }[]>([]);
	let problem = $state<string | null>(null);

	$effect(() => {
		onPendingChange?.(active !== undefined);
	});

	export function flushPending(): 'clean' | 'applied' | 'blocked' {
		if (active === undefined) return 'clean';
		return tryApply() ? 'applied' : 'blocked';
	}

	export function discardPending(): void {
		active = undefined;
		problem = null;
	}

	onDestroy(() => onPendingChange?.(false));
	const keyChoices = $derived(fields.filter(({ name, type }) => name.trim() && type === 'string'));
	const entries = $derived(
		Object.entries(signals).map(([id, signal]) => ({
			id,
			summary:
				signal.delivery === 'many'
					? m.workflow_studio_keyed_signal_summary({ key: signal.key })
					: labels[signal.payload](),
		})),
	);

	function edit(key: string | null) {
		const signal = key ? signals[key] : undefined;
		name = key ?? '';
		payload = signal?.payload ?? 'none';
		keyed = signal?.delivery === 'many';
		repeatKey = signal?.delivery === 'many' ? signal.key : '';
		fields = Object.entries(signal?.payload === 'json' ? (signal.fields ?? {}) : {}).map(
			([name, type]) => ({ id: name, name, type }),
		);
		problem = null;
		active = key;
	}

	function tryApply(): boolean {
		const key = active ?? name.trim();
		problem = null;
		if (!key || (active === null && !isNewWorkflowField(key, signals))) {
			problem = m.workflow_studio_unique_key();
			return false;
		}
		let definition: WorkflowSignalDefinition;
		if (payload === 'json') {
			const schema: Record<string, WorkflowValueType> = {};
			for (const field of fields) {
				const fieldName = field.name.trim();
				if (!isNewWorkflowField(fieldName, schema)) {
					problem = m.workflow_studio_unique_key();
					return false;
				}
				schema[fieldName] = field.type;
			}
			if (keyed && (!Object.hasOwn(schema, repeatKey) || schema[repeatKey] !== 'string')) {
				problem = m.workflow_studio_choose_repeat_key();
				return false;
			}
			definition = keyed
				? { payload, delivery: 'many', key: repeatKey, fields: schema }
				: { payload, delivery: 'once', ...(fields.length ? { fields: schema } : {}) };
		} else definition = { payload, delivery: 'once' };
		if (!onChange({ ...signals, [key]: definition })) return false;
		active = undefined;
		return true;
	}

	function apply(event: SubmitEvent) {
		event.preventDefault();
		tryApply();
	}

	function remove(key: string) {
		const next = Object.entries(signals).filter(([name]) => name !== key);
		if (onChange(next.length ? Object.fromEntries(next) : undefined)) active = undefined;
	}
</script>

<WorkflowNamedEntries
	title={m.workflow_studio_emitted_signals()}
	add={m.workflow_studio_add_signal()}
	{entries}
	onEdit={edit}
	onRemove={remove}
>
	{#if active !== undefined}
		<form class="space-y-2 border-l border-border pl-2" onsubmit={apply}>
			<label class="block space-y-1">
				<span>{m.workflow_studio_signal_name()}</span>
				<input
					class="workflow-field"
					required
					maxlength="128"
					readonly={active !== null}
					bind:value={name}
				/>
			</label>
			<label class="block space-y-1">
				<span>{m.workflow_studio_signal_payload()}</span>
				<select
					class="workflow-field"
					value={payload}
					onchange={(event) => {
						payload = payloads.find((entry) => entry === event.currentTarget.value) ?? 'none';
					}}
				>
					{#each payloads as option (option)}<option value={option}>{labels[option]()}</option
						>{/each}
				</select>
			</label>
			{#if payload === 'json'}
				<label class="flex items-center gap-2"
					><input type="checkbox" bind:checked={keyed} />
					{m.workflow_studio_keyed_delivery()}</label
				>
				<fieldset class="space-y-2">
					<legend class="font-medium">{m.workflow_studio_payload_fields()}</legend>
					{#each fields as field (field.id)}
						<div class="grid min-w-0 gap-1">
							<label class="space-y-1">
								<span>{m.workflow_studio_payload_field_name()}</span>
								<input class="workflow-field" required maxlength="128" bind:value={field.name} />
							</label>
							<div class="flex items-end gap-1">
								<label class="min-w-0 flex-1 space-y-1">
									<span>{m.workflow_studio_value_type()}</span>
									<select
										class="workflow-field"
										value={field.type}
										onchange={(event) => {
											field.type =
												WORKFLOW_VALUE_TYPES.find((type) => type === event.currentTarget.value) ??
												'string';
										}}
									>
										{#each WORKFLOW_VALUE_TYPES as type (type)}<option value={type}>{type}</option
											>{/each}
									</select>
								</label>
								<Button
									variant="ghost"
									size="icon-sm"
									title={m.workflow_studio_remove_payload_field()}
									aria-label={m.workflow_studio_remove_payload_field()}
									onclick={() => (fields = fields.filter(({ id }) => id !== field.id))}
									><Trash2 class="size-4" /></Button
								>
							</div>
						</div>
					{/each}
					<Button
						variant="outline"
						size="sm"
						onclick={() =>
							(fields = [...fields, { id: createRandomId(), name: '', type: 'string' }])}
						>{m.workflow_studio_add_payload_field()}</Button
					>
				</fieldset>
				{#if keyed}
					<label class="block space-y-1">
						<span>{m.workflow_studio_repeat_key()}</span>
						<select
							class="workflow-field"
							value={repeatKey}
							onchange={(event) => (repeatKey = event.currentTarget.value)}
						>
							<option value="">{m.workflow_studio_choose_repeat_key()}</option>
							{#each keyChoices as field (field.id)}<option value={field.name.trim()}
									>{field.name}</option
								>{/each}
						</select>
					</label>
				{/if}
			{/if}
			{#if problem}<p role="alert" class="text-xs text-destructive">{problem}</p>{/if}
			<div class="flex flex-wrap gap-2">
				<Button type="submit" size="sm">{m.workflow_studio_apply_signal()}</Button>
				<Button size="sm" variant="ghost" onclick={() => (active = undefined)}
					>{m.common_cancel()}</Button
				>
			</div>
		</form>
	{/if}
</WorkflowNamedEntries>
