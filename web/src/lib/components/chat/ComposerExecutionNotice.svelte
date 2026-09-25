<script lang="ts">
	import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
	import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';

	let { nodeId, nodes, catalog, providerAvailable = true }: {
		providerAvailable?: boolean;
		nodeId: string;
		nodes: Pick<ExecutionNodesStore, 'isReady' | 'hasSnapshot' | 'get' | 'label'>;
		catalog: Pick<ModelCatalogStore, 'isValidated' | 'error' | 'forceRefresh'>;
	} = $props();
</script>

{#if !nodes.isReady(nodeId)}
	<p role="status" class="break-words px-4 py-2 text-sm text-muted-foreground" title={nodeId}>
		{#if nodes.hasSnapshot && !nodes.get(nodeId)}
			This chat's execution node is no longer configured.
		{:else}{nodes.label(nodeId)} is unavailable.{/if}
	</p>
{:else if catalog.error}
	<div role="status" class="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground">
		<span class="min-w-0 break-words">{catalog.error}</span>
		<button
			type="button"
			class="text-foreground underline focus-visible:ring-2 focus-visible:ring-ring"
			onclick={() => void catalog.forceRefresh()}>Retry</button
		>
	</div>
{:else if catalog.isValidated && !providerAvailable}
	<p role="status" class="break-words px-4 py-2 text-sm text-muted-foreground">The selected provider or model is unavailable on this node.</p>
{/if}
