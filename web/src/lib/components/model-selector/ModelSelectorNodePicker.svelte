<script lang="ts">
	import type { ModelSelectorState } from './model-selector-state.svelte';
	import { executionNodeStatus } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
	let { selector }: { selector: ModelSelectorState } = $props();
</script>

<div class="shrink-0 border-b border-border px-3 py-2">
	<label class="flex min-w-0 items-center gap-3 text-sm">
		<span>Node</span>
		<select aria-label="Execution node" class="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-base pointer-fine:text-sm" value={selector.nodeId} onchange={(event) => void selector.selectNode(event.currentTarget.value)}>
			{#if !selector.nodes.some((node) => node.id === selector.nodeId)}<option value={selector.nodeId} disabled>{selector.nodeLabel} (Unavailable)</option>{/if}
			{#each selector.nodes as node (node.id)}
				<option value={node.id} disabled={!node.enabled || node.availability !== 'ready'}>{node.label}{node.availability === 'ready' && node.enabled ? '' : ` (${executionNodeStatus(node)})`}</option>
			{/each}
		</select>
	</label>
	{#if selector.modelCatalog.error}<p role="alert" class="mt-1 text-xs text-destructive">{selector.modelCatalog.error}</p>{/if}
</div>
