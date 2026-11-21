<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { onDestroy, untrack } from 'svelte';
	import { getExecutors } from '$lib/context';
	import { validateWorkflowLocation } from '$lib/workflows/launch/validate-workflow-location';
	import { parseWorkflowStepAddition, type WorkflowStep } from '$shared/workflow-definition';
	import {
		inheritedWorkflowPath,
		workflowProducerCanEmit,
		type WorkflowAddStepRequest,
		type WorkflowRunDetail,
	} from '$shared/workflow-runs';
	import {
		nextWorkflowStepId,
		workflowSignalSubscription,
		workflowSignals,
	} from '$lib/workflows/definition/workflow-step-options';
	import { createRandomId } from '$lib/utils/random-id';
	import { workflowRunFinished } from '$lib/workflows/run/workflow-run-projection';
	import type { JsonValue } from '$shared/json';
	import * as m from '$lib/paraglide/messages.js';
	import { workflowStepKindLabel } from './workflow-labels';
	import WorkflowStepSettings from './WorkflowStepSettings.svelte';

	let {
		run,
		initialEvidence,
		disabled,
		onSubmit,
		onCancel,
	}: {
		run: WorkflowRunDetail;
		initialEvidence?: string;
		disabled: boolean;
		onSubmit: (request: WorkflowAddStepRequest) => void;
		onCancel: () => void;
	} = $props();

	const kinds = ['agent', 'command', 'decision'] as const;
	const executors = getExecutors();
	let mounted = true;
	let checking = $state(false);
	onDestroy(() => {
		mounted = false;
	});
	let kind = $state<WorkflowStep['kind']>('agent');
	let title = $state('');
	let instruction = $state('');
	let path = $state('');
	let configured = $state.raw<Readonly<Record<string, JsonValue | undefined>>>({});
	let configure = $state(false);
	let mode = $state<'root' | 'future' | 'result'>(
		untrack(() => (initialEvidence ? 'result' : 'root')),
	);
	let evidenceId = $state(untrack(() => initialEvidence ?? ''));
	let signalRef = $state('');
	let useResult = $state(true);
	let problem = $state<string | null>(null);
	const base = $derived({
		...run.pinnedRevision.definition,
		steps: run.steps.map(({ step }) => step),
	});
	const futureSignals = $derived.by(() => {
		const producers = run.steps.filter(
			({ step, intake, instances }) =>
				step.on?.kind !== 'each' &&
				workflowProducerCanEmit(
					intake === 'open',
					instances[0]?.status,
					instances[0]?.attempts.length,
				),
		);
		const emitted = new Set(run.signals.map(({ ref }) => `${ref.stepId}.${ref.signal}`));
		return workflowSignals(producers.map(({ step }) => step)).filter(
			(option) => option.delivery === 'many' || !emitted.has(option.value),
		);
	});
	const signal = $derived(futureSignals.find(({ value }) => value === signalRef));
	const evidence = $derived(run.signals.find(({ id }) => id === evidenceId));
	const missingDependency = $derived(
		(mode === 'future' && !signal) || (mode === 'result' && !evidence),
	);
	const defaultTarget = $derived(run.executionContext.defaultTarget);
	const target = $derived(
		typeof configured.executorId === 'string' ? configured.executorId : defaultTarget?.executorId,
	);
	const inheritedPath = $derived(inheritedWorkflowPath(run.executionContext, target));
	const requiredPath = $derived(kind !== 'decision' && !inheritedPath);
	const missingTarget = $derived(kind !== 'decision' && !target);
	const stepBlocked = $derived(
		disabled || configure || missingDependency || missingTarget || workflowRunFinished(run),
	);
	const executionFields = $derived({ ...configured, projectPath: path.trim() || undefined });
	const seed = $derived(
		kind === 'decision'
			? null
			: ({
					...executionFields,
					id: 'manual',
					name: title,
					...(kind === 'command' ? { kind, command: instruction } : { kind, prompt: instruction }),
				} satisfies WorkflowStep),
	);

	async function addStep(event: SubmitEvent) {
		event.preventDefault();
		problem = null;
		if (
			checking ||
			stepBlocked ||
			!title.trim() ||
			!instruction.trim() ||
			(requiredPath && !path.trim())
		) {
			return;
		}
		const selected = mode === 'result' ? evidence : undefined;
		const bindResult = selected?.payload !== undefined && useResult && kind !== 'command';
		const on = mode === 'future' && signal ? workflowSignalSubscription(signal) : undefined;
		const source = JSON.stringify(
			{
				id: nextWorkflowStepId(base.steps, 'manual'),
				name: title.trim(),
				kind,
				on,
				...(kind === 'command'
					? { command: instruction }
					: { prompt: bindResult ? `${instruction}\n\n{{result}}` : instruction }),
				...(kind === 'decision'
					? {
							choices: { approve: m.workflow_studio_approve(), reject: m.workflow_studio_reject() },
						}
					: executionFields),
				...(bindResult ? { bindings: { result: 'signal' } } : {}),
			},
			null,
			2,
		);
		const parsed = parseWorkflowStepAddition(
			base,
			source,
			selected ? { evidence: selected.ref } : undefined,
		);
		if (!parsed.step) {
			problem = parsed.diagnostics.map(({ message }) => message).join(' ');
			return;
		}
		if (kind !== 'decision' && target) {
			checking = true;
			try {
				const projectPath = executionFields.projectPath ?? inheritedPath;
				if (!projectPath) return;
				problem = await validateWorkflowLocation({ executorId: target, projectPath }, executors);
				if (problem || !mounted || stepBlocked) return;
			} catch (error) {
				problem = error instanceof Error ? error.message : m.workflow_studio_action_failed();
				return;
			} finally {
				checking = false;
			}
		}
		onSubmit({
			runId: run.id,
			operationId: createRandomId(),
			source,
			evidenceSignalId: selected?.id,
		});
	}
</script>

<form class="space-y-3" onsubmit={addStep}>
	<fieldset disabled={checking} class="min-w-0 space-y-3">
		<h3 class="text-sm font-semibold">{m.workflow_studio_add_step()}</h3>
		<label class="block space-y-1 text-sm">
			<span>{m.workflow_studio_step_kind()}</span>
			<select
				class="workflow-field"
				value={kind}
				onchange={(event) => {
					const selected = kinds.find((entry) => entry === event.currentTarget.value);
					if (!selected) return;
					kind = selected;
					configured = {};
					configure = false;
				}}
			>
				{#each kinds as option (option)}<option value={option}
						>{workflowStepKindLabel(option)}</option
					>{/each}
			</select>
		</label>
		<label class="block space-y-1 text-sm">
			<span>{m.workflow_studio_step_name()}</span>
			<input class="workflow-field" required maxlength="256" bind:value={title} />
		</label>
		<label class="block space-y-1 text-sm">
			<span>{kind === 'command' ? m.workflow_studio_command() : m.workflow_studio_prompt()}</span>
			<textarea class="workflow-field min-h-24" required bind:value={instruction}></textarea>
		</label>
		{#if kind !== 'decision'}
			<label class="block space-y-1 text-sm">
				<span>{m.chat_new_chat_project_path()}</span>
				<input
					class="workflow-field"
					required={requiredPath}
					placeholder={inheritedPath}
					bind:value={path}
				/>
			</label>
			{#if missingTarget}
				<p class="text-sm text-muted-foreground">{m.workflow_studio_choose_step_executor()}</p>
			{:else}
				<p class="wrap-anywhere text-xs text-muted-foreground">
					{target}{#if configured.model}
						· {configured.model}{/if}
				</p>
			{/if}
			<Button
				type="button"
				size="sm"
				variant="outline"
				aria-expanded={configure}
				onclick={() => (configure = !configure)}>{m.workflow_studio_step_settings()}</Button
			>
			{#if configure && seed}
				<WorkflowStepSettings
					step={seed}
					context={defaultTarget
						? { executorId: defaultTarget.executorId, cwd: defaultTarget.projectPath }
						: null}
					narrow
					{disabled}
					requireExecutor={!defaultTarget}
					onApply={(fields) => {
						configured = fields;
						path = typeof fields.projectPath === 'string' ? fields.projectPath : '';
						configure = false;
					}}
				/>
			{/if}
		{/if}
		<label class="block space-y-1 text-sm">
			<span>{m.workflow_studio_dependency()}</span>
			<select
				class="workflow-field"
				value={mode}
				onchange={(event) => {
					const next = event.currentTarget.value;
					if (next === 'future' || next === 'result' || next === 'root') mode = next;
				}}
			>
				<option value="root">{m.workflow_studio_independent()}</option>
				<option value="future" disabled={!futureSignals.length}
					>{m.workflow_studio_future_signal()}</option
				>
				<option value="result" disabled={!run.signals.length}
					>{m.workflow_studio_stored_result()}</option
				>
			</select>
		</label>
		{#if mode === 'future'}
			<label class="block space-y-1 text-sm">
				<span>{m.workflow_studio_signal()}</span>
				<select
					class="workflow-field"
					required
					value={signalRef}
					onchange={(event) => (signalRef = event.currentTarget.value)}
				>
					<option value="">{m.workflow_studio_choose_signal()}</option>
					{#each futureSignals as option (option.value)}<option value={option.value}
							>{option.label}</option
						>{/each}
				</select>
			</label>
		{:else if mode === 'result'}
			<label class="block space-y-1 text-sm">
				<span>{m.workflow_studio_evidence()}</span>
				<select
					class="workflow-field"
					required
					value={evidenceId}
					onchange={(event) => (evidenceId = event.currentTarget.value)}
				>
					<option value="">{m.workflow_studio_choose_result()}</option>
					{#each run.signals as item (item.id)}
						<option value={item.id}
							>{item.ref.stepId}.{item.ref.signal}{item.key === null ? '' : ` · ${item.key}`} · {new Date(
								item.createdAt,
							).toLocaleTimeString()}</option
						>
					{/each}
				</select>
			</label>
			{#if evidence?.payload !== undefined && kind !== 'command'}
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" bind:checked={useResult} />
					{m.workflow_studio_bind_result()}
				</label>
			{/if}
		{/if}
		<p class="wrap-anywhere text-sm text-muted-foreground">
			{mode === 'future' ? m.workflow_studio_wait_preview() : m.workflow_studio_start_preview()}
		</p>
		{#if problem}<p role="alert" class="wrap-anywhere text-sm text-destructive">{problem}</p>{/if}
		<div class="flex flex-wrap gap-2">
			<Button type="submit" size="sm" disabled={stepBlocked || checking}
				>{m.workflow_studio_add_step()}</Button
			>
			<Button size="sm" variant="ghost" onclick={onCancel}>{m.common_cancel()}</Button>
		</div>
	</fieldset>
</form>
