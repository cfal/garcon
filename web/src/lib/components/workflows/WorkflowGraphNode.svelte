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
	import { workflowStepKindLabel } from './workflow-labels';
	let { data }: NodeProps<StepGraphNode> = $props();
</script>

<Handle id="in" type="target" position={Position.Left} isConnectable={false} />
<button
	type="button"
	class="nodrag nopan flex h-full w-full min-w-0 flex-col justify-center gap-1 rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-ring aria-pressed:bg-accent"
	aria-pressed={data.active}
	data-workflow-step={data.step.id}
	onclick={() => data.onSelect(data.step.id)}
>
	<span class="block w-full truncate text-sm font-medium" title={data.step.title}
		>{data.step.title}</span
	>
	<span class="block w-full truncate text-xs text-muted-foreground"
		>{data.step.detail ?? workflowStepKindLabel(data.step.kind)}</span
	>
</button>
<Handle id="out" type="source" position={Position.Right} isConnectable={false} />
