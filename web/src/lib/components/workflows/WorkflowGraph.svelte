<script lang="ts">
	import { Background, Controls, MarkerType, SvelteFlow, type Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/base.css';
	import * as m from '$lib/paraglide/messages.js';
	import {
		workflowGraphPositions,
		type WorkflowGraphEdge,
		type WorkflowGraphFocus,
		type WorkflowGraphNode,
	} from '$lib/workflows/definition/workflow-graph';
	import StepNode, { type StepGraphNode } from './WorkflowGraphNode.svelte';
	import WorkflowGraphCamera from './WorkflowGraphCamera.svelte';

	let {
		steps,
		connections,
		selected,
		onSelect,
		focusRequest = null,
	}: {
		steps: readonly WorkflowGraphNode[];
		connections: readonly WorkflowGraphEdge[];
		selected: string | null;
		onSelect: (id: string) => void;
		focusRequest?: WorkflowGraphFocus | null;
	} = $props();

	let surface = $state<HTMLDivElement>();
	const positions = $derived(workflowGraphPositions(steps, connections));
	const nodeTypes = { step: StepNode };
	const nodes = $derived<StepGraphNode[]>(
		steps.map((step) => ({
			id: step.id,
			type: 'step',
			data: { step, active: selected === step.id, onSelect },
			position: positions.get(step.id)!,
			width: 216,
			height: 74,
		})),
	);
	const edges = $derived<Edge[]>(
		connections.flatMap(({ source, target, label }, index) =>
			positions.has(source) && positions.has(target)
				? [
						{
							id: `workflow-edge-${index}`,
							source,
							target,
							label,
							markerEnd: MarkerType.ArrowClosed,
						},
					]
				: [],
		),
	);
</script>

<div
	class="workflow-graph h-full min-h-60 w-full bg-background"
	role="group"
	aria-label={m.workflow_studio_graph()}
	bind:this={surface}
>
	<SvelteFlow
		{nodes}
		{edges}
		{nodeTypes}
		fitView
		fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
		minZoom={0.1}
		proOptions={{ hideAttribution: true }}
		nodesDraggable={false}
		nodesConnectable={false}
		nodesFocusable={false}
		edgesFocusable={false}
		elementsSelectable={false}
		deleteKey={null}
	>
		<Background patternColor="hsl(var(--border))" gap={20} />
		<Controls showLock={false} />
		<WorkflowGraphCamera {surface} {focusRequest} />
	</SvelteFlow>
</div>

<style>
	.workflow-graph {
		--xy-background-color: hsl(var(--background));
		--xy-edge-stroke-default: hsl(var(--muted-foreground));
		--xy-edge-label-color-default: hsl(var(--foreground));
		--xy-edge-label-background-color-default: hsl(var(--background));
		--xy-controls-button-background-color-default: hsl(var(--card));
		--xy-controls-button-background-color-hover-default: hsl(var(--accent));
		--xy-controls-button-color-default: hsl(var(--foreground));
		--xy-controls-button-border-color-default: hsl(var(--border));
	}
</style>
