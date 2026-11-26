<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import type {
		WorkflowGraphEdge,
		WorkflowGraphNode,
	} from '$lib/workflows/definition/workflow-graph';
	import * as m from '$lib/paraglide/messages.js';
	import WorkflowStepToneIcon from './WorkflowStepToneIcon.svelte';
	import { workflowStepKindLabel, workflowToneTextClass } from './workflow-labels';

	let {
		steps,
		edges,
		selected,
		onSelect,
	}: {
		steps: readonly WorkflowGraphNode[];
		edges: readonly WorkflowGraphEdge[];
		selected: string | null;
		onSelect: (id: string) => void;
	} = $props();

	const titles = $derived(new Map(steps.map(({ id, title }) => [id, title])));
	const incoming = $derived.by(() => {
		const result = new Map<string, string[]>();
		for (const { source, target, label } of edges) {
			const parent = titles.get(source) ?? source;
			if (!result.has(target)) result.set(target, []);
			result.get(target)!.push(label ? `${parent} / ${label}` : parent);
		}
		return result;
	});
</script>

<ul class="divide-y divide-border" aria-label={m.workflow_studio_steps()}>
	{#each steps as step (step.id)}
		<svelte:boundary>
			<li>
				<button
					type="button"
					class="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 py-3 text-left hover:bg-muted focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-pressed:bg-accent"
					data-workflow-step={step.id}
					data-workflow-tone={step.tone}
					aria-pressed={selected === step.id}
					onclick={() => onSelect(step.id)}
				>
					<span class="min-w-0 space-y-1">
						<span class="flex min-w-0 items-center gap-1.5">
							{#if step.tone}
								<WorkflowStepToneIcon tone={step.tone} />
							{/if}
							<span class="min-w-0 wrap-anywhere text-sm font-medium">{step.title}</span>
						</span>
						<span class="block wrap-anywhere text-xs {workflowToneTextClass(step.tone)}">
							{workflowStepKindLabel(step.kind)}{#if step.detail}
								· {step.detail}{/if}
						</span>
						{#if incoming.has(step.id)}
							<span class="block wrap-anywhere text-xs text-muted-foreground">
								{m.workflow_studio_after({ signals: incoming.get(step.id)!.join(', ') })}
							</span>
						{/if}
					</span>
					<ChevronRight class="size-4 text-muted-foreground" aria-hidden="true" />
				</button>
			</li>
			{#snippet failed()}<li class="p-4 text-sm text-destructive">
					{m.workflow_studio_step_unavailable()}
				</li>{/snippet}
		</svelte:boundary>
	{:else}
		<li class="p-4 text-sm text-muted-foreground">{m.workflow_studio_no_steps()}</li>
	{/each}
</ul>
