<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getExecutionNodes } from '$lib/context';

	let { children }: { children: Snippet<[nodeId: string]> } = $props();
	const nodes = getExecutionNodes();
</script>

<div class="space-y-6">
	{#each nodes.nodes as node (node.id)}
		<svelte:boundary>
			<section class="min-w-0 space-y-3" aria-label={node.label}>
				{#if nodes.hasRemoteNodes}
					<h3 class="break-words text-sm font-semibold text-foreground">{node.label}</h3>
				{/if}
				{@render children(node.id)}
			</section>
			{#snippet failed()}
				<p class="text-sm text-destructive">Unable to display settings for {node.label}.</p>
			{/snippet}
		</svelte:boundary>
	{/each}
</div>
