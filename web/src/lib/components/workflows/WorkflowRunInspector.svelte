<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Plus from '@lucide/svelte/icons/plus';
	import {
		WORKFLOW_ATTEMPT_LIMIT,
		type WorkflowRunDetail,
		type WorkflowRunStep,
		type WorkflowStepInstance,
	} from '$shared/workflow-runs';
	import { stepEvidence, workflowRunFinished } from '$lib/workflows/run/workflow-run-projection';
	import * as m from '$lib/paraglide/messages.js';
	import { workflowStatusLabel, workflowStepKindLabel } from './workflow-labels';

	let {
		run,
		step,
		instance,
		disabled,
		onOpenChat,
		onDecide,
		onRetry,
		onAddItem,
		onAddFromEvidence,
	}: {
		run: WorkflowRunDetail;
		step: WorkflowRunStep;
		instance: WorkflowStepInstance | null;
		disabled: boolean;
		onOpenChat: (id: string) => void;
		onDecide: (instanceId: string, choice: string) => void;
		onRetry: (instanceId: string) => void;
		onAddItem: () => void;
		onAddFromEvidence: (id: string) => void;
	} = $props();

	const signals = $derived(stepEvidence(step, instance, run.signals));
	const canAmend = $derived(!workflowRunFinished(run));
	const chatAvailability = $derived(
		new Map(
			run.steps.flatMap(({ instances }) =>
				instances.flatMap(({ attempts }) =>
					attempts.flatMap(({ chatId, chatAvailable }) =>
						chatId ? [[chatId, chatAvailable] as const] : [],
					),
				),
			),
		),
	);
</script>

<div class="space-y-4">
	<div class="space-y-1">
		<p class="wrap-anywhere text-xs text-muted-foreground">
			{workflowStepKindLabel(step.step.kind)} · {step.step.id}
		</p>
		{#if step.location}
			<p class="wrap-anywhere text-sm">
				<span class="text-muted-foreground">{step.location.executorId}</span>
				<code class="text-xs">{step.location.projectPath}</code>
			</p>
		{/if}
		{#if step.settings}
			<details class="text-sm">
				<summary class="cursor-pointer">{m.workflow_studio_step_settings()}</summary>
				<pre class="mt-2 whitespace-pre-wrap wrap-anywhere bg-muted p-2 text-xs">{JSON.stringify(
						step.settings,
						null,
						2,
					)}</pre>
			</details>
		{/if}
		{#if step.waitingReason}<p class="wrap-anywhere text-sm text-muted-foreground">
				{step.waitingReason}
			</p>{/if}
		{#if step.step.on?.kind === 'each'}
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-xs text-muted-foreground"
					>{step.intake === 'open'
						? m.workflow_studio_intake_open()
						: m.workflow_studio_intake_closed()}</span
				>
				{#if step.intake === 'open' && canAmend}
					<Button size="sm" variant="outline" {disabled} onclick={onAddItem}>
						<Plus class="size-4" />
						{m.workflow_studio_add_item()}
					</Button>
				{/if}
			</div>
		{/if}
	</div>
	{#if instance}
		<div class="space-y-2 border-t border-border pt-3">
			<h3 class="wrap-anywhere text-sm font-semibold">
				{instance.key ?? m.workflow_studio_instance()} · {workflowStatusLabel(instance.status)}
			</h3>
			{#if instance.reason}<p class="wrap-anywhere text-sm text-muted-foreground">
					{instance.reason}
				</p>{/if}
			{#if instance.status === 'awaiting-decision' && step.step.kind === 'decision' && canAmend}
				<p class="whitespace-pre-wrap wrap-anywhere text-sm">
					{instance.prompt ?? step.step.prompt}
				</p>
				<div class="flex flex-wrap gap-2">
					{#each Object.entries(step.step.choices) as [key, label] (key)}
						<Button
							class="h-auto max-w-full whitespace-normal"
							variant="outline"
							{disabled}
							onclick={() => onDecide(instance.id, key)}>{label}</Button
						>
					{/each}
				</div>
			{:else if instance.status === 'failed' && instance.attempts.length < WORKFLOW_ATTEMPT_LIMIT && canAmend}
				<Button variant="outline" size="sm" {disabled} onclick={() => onRetry(instance.id)}
					>{m.workflow_studio_retry_step()}</Button
				>
			{:else if instance.status === 'unknown'}
				<p class="wrap-anywhere text-sm text-status-warning-foreground">
					{m.workflow_studio_inspect_unknown()}
				</p>
			{/if}
			{#if instance.bindings}
				<details class="text-sm">
					<summary class="cursor-pointer">{m.workflow_studio_bound_inputs()}</summary>
					<pre class="mt-2 whitespace-pre-wrap wrap-anywhere bg-muted p-2 text-xs">{JSON.stringify(
							instance.bindings,
							null,
							2,
						)}</pre>
				</details>
			{/if}
			{#if instance.prompt && (instance.status !== 'awaiting-decision' || !canAmend)}
				<details class="text-sm">
					<summary class="cursor-pointer">{m.workflow_studio_exact_prompt()}</summary>
					<pre
						class="mt-2 whitespace-pre-wrap wrap-anywhere bg-muted p-2 text-xs">{instance.prompt}</pre>
				</details>
			{/if}
		</div>
		{#if instance.attempts.length}
			<div class="space-y-2 border-t border-border pt-3">
				<h3 class="text-sm font-semibold">{m.workflow_studio_attempts()}</h3>
				<ol class="divide-y divide-border">
					{#each instance.attempts as attempt (attempt.id)}
						<svelte:boundary>
							<li class="space-y-1 py-2">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<span class="text-sm"
										>{m.workflow_studio_attempt({ number: attempt.number })} · {workflowStatusLabel(
											attempt.status,
										)}</span
									>
									{#if attempt.chatId && attempt.chatAvailable}
										{@const chatId = attempt.chatId}
										<Button variant="ghost" size="sm" onclick={() => onOpenChat(chatId)}>
											<MessageSquare class="size-4" />
											{m.workflow_studio_open_chat()}
										</Button>
									{:else if attempt.chatId}
										<span class="text-xs text-muted-foreground"
											>{m.workflow_studio_chat_unavailable()}</span
										>
									{/if}
								</div>
								<time datetime={attempt.startedAt} class="text-xs text-muted-foreground"
									>{new Date(attempt.startedAt).toLocaleString()}</time
								>
								{#if attempt.reason}<p class="wrap-anywhere text-xs text-muted-foreground">
										{attempt.reason}
									</p>{/if}
							</li>
							{#snippet failed()}<li class="text-sm text-destructive">
									{m.workflow_studio_evidence_unavailable()}
								</li>{/snippet}
						</svelte:boundary>
					{/each}
				</ol>
			</div>
		{/if}
	{/if}
	{#if signals.length}
		<div class="space-y-2 border-t border-border pt-3">
			<h3 class="text-sm font-semibold">{m.workflow_studio_evidence()}</h3>
			<ul class="divide-y divide-border">
				{#each signals as signal (signal.id)}
					<svelte:boundary>
						<li class="space-y-2 py-2">
							<details class="min-w-0 text-sm">
								<summary class="cursor-pointer wrap-anywhere">
									{signal.ref.stepId}.{signal.ref.signal}{#if signal.key !== null}
										· {signal.key}{/if}
								</summary>
								{#if signal.payload !== undefined}<pre
										class="mt-2 whitespace-pre-wrap wrap-anywhere bg-muted p-2 text-xs">{typeof signal.payload ===
										'string'
											? signal.payload
											: JSON.stringify(signal.payload, null, 2)}</pre>{/if}
								<time datetime={signal.createdAt} class="text-xs text-muted-foreground"
									>{new Date(signal.createdAt).toLocaleString()}</time
								>
								{#if 'actor' in signal.source}
									<p class="wrap-anywhere text-sm">
										{m.workflow_studio_recorded_by({ name: signal.source.actor.name })}
									</p>
								{:else}
									{@const chatId = signal.source.chatId}
									{#if chatAvailability.get(chatId)}
										<Button variant="ghost" size="sm" onclick={() => onOpenChat(chatId)}
											>{m.workflow_studio_open_source_chat()}</Button
										>
									{:else}
										<span class="text-xs text-muted-foreground"
											>{m.workflow_studio_chat_unavailable()}</span
										>
									{/if}
								{/if}
								{#if canAmend}
									<Button
										variant="outline"
										size="sm"
										{disabled}
										onclick={() => onAddFromEvidence(signal.id)}
										>{m.workflow_studio_add_from_result()}</Button
									>
								{/if}
							</details>
						</li>
						{#snippet failed()}<li class="text-sm text-destructive">
								{m.workflow_studio_evidence_unavailable()}
							</li>{/snippet}
					</svelte:boundary>
				{/each}
			</ul>
		</div>
	{/if}
</div>
