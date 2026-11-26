<script module lang="ts">
	import type { Node } from '@xyflow/svelte';
	import type { WorkflowGraphNode } from '$lib/workflows/definition/workflow-graph';

	export type StepGraphNode = Node<
		{
			step: WorkflowGraphNode;
			active: boolean;
			onSelect: (id: string) => void;
		},
		'step'
	>;
</script>

<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import WorkflowStepToneIcon from './WorkflowStepToneIcon.svelte';
	import {
		workflowStepKindLabel,
		workflowToneCardClass,
		workflowToneTextClass,
	} from './workflow-labels';
	let { data }: NodeProps<StepGraphNode> = $props();
</script>

<Handle id="in" type="target" position={Position.Left} isConnectable={false} />
<button
	type="button"
	class="nodrag nopan flex h-full w-full min-w-0 flex-col justify-center gap-1 rounded-md border px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-ring aria-pressed:bg-accent {workflowToneCardClass(
		data.step.tone,
	)}"
	aria-pressed={data.active}
	data-workflow-step={data.step.id}
	data-workflow-tone={data.step.tone}
	onclick={() => data.onSelect(data.step.id)}
>
	<span class="flex w-full min-w-0 items-center gap-1.5">
		{#if data.step.tone}
			<WorkflowStepToneIcon tone={data.step.tone} />
		{/if}
		<span class="min-w-0 flex-1 truncate text-sm font-medium" title={data.step.title}
			>{data.step.title}</span
		>
	</span>
	<span class="block w-full truncate text-xs {workflowToneTextClass(data.step.tone)}"
		>{data.step.detail ?? workflowStepKindLabel(data.step.kind)}</span
	>
</button>
<Handle id="out" type="source" position={Position.Right} isConnectable={false} />
