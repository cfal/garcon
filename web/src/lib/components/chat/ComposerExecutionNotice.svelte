<script lang="ts">
	import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
	import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';

	let { executorId, executors, catalog, providerAvailable = true }: {
		providerAvailable?: boolean;
		executorId: string;
		executors: Pick<ExecutorsStore, 'isReady' | 'hasSnapshot' | 'get' | 'label'>;
		catalog: Pick<ModelCatalogStore, 'isValidated' | 'error' | 'forceRefresh'>;
	} = $props();
</script>

{#if !executors.isReady(executorId)}
	<p role="status" class="break-words px-4 py-2 text-sm text-muted-foreground" title={executorId}>
		{#if executors.hasSnapshot && !executors.get(executorId)}
			This chat's executor is no longer configured.
		{:else}{executors.label(executorId)} is unavailable.{/if}
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
	<p role="status" class="break-words px-4 py-2 text-sm text-muted-foreground">The selected provider or model is unavailable on this executor.</p>
{/if}
