<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { isNewWorkflowField } from '$lib/workflows/definition/workflow-named-fields';
	import * as m from '$lib/paraglide/messages.js';
	import WorkflowNamedEntries from './WorkflowNamedEntries.svelte';

	let {
		choices,
		onPendingChange,
		onChange,
	}: {
		choices: Readonly<Record<string, string>>;
		onPendingChange?: (pending: boolean) => void;
		onChange: (choices: Readonly<Record<string, string>>) => boolean;
	} = $props();

	let active = $state<string | null | undefined>();
	let key = $state('');
	let label = $state('');
	let invalid = $state(false);
	const entries = $derived(Object.entries(choices).map(([id, summary]) => ({ id, summary })));

	$effect(() => {
		onPendingChange?.(active !== undefined);
	});

	export function flushPending(): 'clean' | 'applied' | 'blocked' {
		if (active === undefined) return 'clean';
		return tryApply() ? 'applied' : 'blocked';
	}

	export function discardPending(): void {
		active = undefined;
		invalid = false;
	}

	onDestroy(() => onPendingChange?.(false));

	function edit(id: string | null) {
		key = id ?? '';
		label = id ? choices[id] : '';
		invalid = false;
		active = id;
	}

	function tryApply(): boolean {
		const id = active ?? key.trim();
		invalid = !id || (active === null && !isNewWorkflowField(id, choices));
		if (invalid || !label.trim() || !onChange({ ...choices, [id]: label })) return false;
		active = undefined;
		return true;
	}

	function apply(event: SubmitEvent) {
		event.preventDefault();
		tryApply();
	}

	function remove(key: string) {
		if (entries.length < 2) return;
		if (onChange(Object.fromEntries(Object.entries(choices).filter(([name]) => name !== key))))
			active = undefined;
	}
</script>

<WorkflowNamedEntries
	title={m.workflow_studio_decision_choices()}
	add={m.workflow_studio_add_choice()}
	{entries}
	canRemove={entries.length > 1}
	onEdit={edit}
	onRemove={remove}
>
	{#if active !== undefined}
		<form class="space-y-2 border-l border-border pl-2" onsubmit={apply}>
			<label class="block space-y-1">
				<span>{m.workflow_studio_choice_id()}</span>
				<input
					class="workflow-field"
					required
					maxlength="128"
					readonly={active !== null}
					bind:value={key}
				/>
			</label>
			<label class="block space-y-1">
				<span>{m.workflow_studio_choice_label()}</span>
				<input class="workflow-field" required maxlength="256" bind:value={label} />
			</label>
			{#if invalid}<p role="alert" class="text-xs text-destructive">
					{m.workflow_studio_unique_key()}
				</p>{/if}
			<div class="flex flex-wrap gap-2">
				<Button type="submit" size="sm">{m.workflow_studio_apply_choice()}</Button>
				<Button size="sm" variant="ghost" onclick={() => (active = undefined)}
					>{m.common_cancel()}</Button
				>
			</div>
		</form>
	{/if}
</WorkflowNamedEntries>
