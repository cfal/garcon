<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { isRecord, type JsonValue } from '$shared/json';
	import { getWorkflowStepSignal } from '$shared/workflow-definition';
	import type {
		WorkflowAddItemRequest,
		WorkflowRunDetail,
		WorkflowRunStep,
	} from '$shared/workflow-runs';
	import { parseWorkflowJson } from '$lib/workflows/launch/workflow-inputs';
	import { createRandomId } from '$lib/utils/random-id';
	import { workflowRunFinished } from '$lib/workflows/run/workflow-run-projection';
	import * as m from '$lib/paraglide/messages.js';

	let {
		run,
		target,
		disabled,
		onSubmit,
		onCancel,
	}: {
		run: WorkflowRunDetail;
		target: WorkflowRunStep;
		disabled: boolean;
		onSubmit: (request: WorkflowAddItemRequest) => void;
		onCancel: () => void;
	} = $props();

	let itemKey = $state('');
	const key = $derived(itemKey.trim());
	let text = $state('{}');
	let problem = $state<string | null>(null);
	const shape = $derived.by(() => {
		const on = target.step.on;
		if (on?.kind !== 'each') return null;
		const producer = run.steps.find(({ step }) => step.id === on.signal.stepId);
		const signal = producer && getWorkflowStepSignal(producer.step, on.signal.signal);
		return signal?.delivery === 'many' ? signal : null;
	});
	const itemBlocked = $derived(
		disabled || workflowRunFinished(run) || target.intake !== 'open' || !key,
	);

	function addItem(event: SubmitEvent) {
		event.preventDefault();
		problem = null;
		if (itemBlocked || !shape) return;
		let payload: JsonValue;
		try {
			const value = parseWorkflowJson(text);
			if (!isRecord(value)) throw new Error();
			payload = Object.hasOwn(value, shape.key) ? value : { ...value, [shape.key]: key };
		} catch {
			problem = m.workflow_studio_json_object_required();
			return;
		}
		if (payload[shape.key] !== key) {
			problem = m.workflow_studio_item_key_mismatch({ field: shape.key });
			return;
		}
		onSubmit({
			runId: run.id,
			operationId: createRandomId(),
			stepId: target.step.id,
			key,
			payload,
		});
	}
</script>

<form class="space-y-3" onsubmit={addItem}>
	<h3 class="wrap-anywhere text-sm font-semibold">
		{m.workflow_studio_add_item_title({ step: target.step.name ?? target.step.id })}
	</h3>
	{#if target.intake === 'closed'}
		<p role="status" class="text-sm text-muted-foreground">{m.workflow_studio_intake_closed()}</p>
	{:else if shape}
		<p class="wrap-anywhere text-sm text-muted-foreground">
			{m.workflow_studio_add_item_preview()}
		</p>
		<label class="block space-y-1 text-sm">
			<span>{m.workflow_studio_item_key({ field: shape.key })}</span>
			<input class="workflow-field" required maxlength="256" bind:value={itemKey} />
		</label>
		<label class="block space-y-1 text-sm">
			<span>{m.workflow_studio_payload()}</span>
			<textarea class="workflow-field min-h-28 font-mono" spellcheck={false} bind:value={text}
			></textarea>
		</label>
		<p class="wrap-anywhere text-xs text-muted-foreground">
			{Object.entries(shape.fields)
				.map(([field, type]) => `${field}: ${type}`)
				.join(', ')}
		</p>
	{/if}
	{#if problem}<p role="alert" class="text-sm text-destructive">{problem}</p>{/if}
	<div class="flex flex-wrap gap-2">
		<Button type="submit" size="sm" disabled={itemBlocked || !shape}>
			{m.workflow_studio_add_item()}
		</Button>
		<Button size="sm" variant="ghost" onclick={onCancel}>{m.common_cancel()}</Button>
	</div>
</form>
