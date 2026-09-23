<script lang="ts">
	import type { ModelSelectorState } from './model-selector-state.svelte';
	import { executionNodeStatus } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
	import Network from '@lucide/svelte/icons/network';
	import Check from '@lucide/svelte/icons/check';
	import { cn } from '$lib/utils/cn';
	interface Props {
		selector: ModelSelectorState;
		onSelect?: (id: string) => void;
	}
	let {
		selector,
		onSelect = (id) => {
			void selector.selectNode(id);
		},
	}: Props = $props();
</script>

<section
	aria-label="Execution nodes"
	data-slot="model-selector-nodes"
	class="h-full min-h-0 overflow-y-auto overscroll-contain p-1"
>
	<div class="flex items-center gap-2 px-2 py-1.5 text-xs font-medium text-muted-foreground">
		<Network class="size-4 text-file-icon-folder" />Node
	</div>
	{#if !selector.nodes.some((node) => node.id === selector.nodeId)}
		<p class="break-words px-2 py-1.5 text-sm text-muted-foreground">
			{selector.draftNodeLabel} (Unavailable)
		</p>
	{/if}
	{#each selector.nodes as node (node.id)}
		<svelte:boundary>
			{@const nodeReady = node.enabled && node.availability === 'ready'}
			<button
				type="button"
				disabled={!nodeReady}
				class={cn(
					'flex min-h-11 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
					node.id === selector.nodeId && 'bg-accent text-accent-foreground',
				)}
				aria-pressed={node.id === selector.nodeId}
				onclick={() => onSelect(node.id)}
			>
				<span class="min-w-0 flex-1 break-words"
					>{node.label}
					{#if !nodeReady}<span class="block text-xs text-muted-foreground"
							>{executionNodeStatus(node)}</span
						>{/if}
				</span>
				{#if node.id === selector.nodeId}<Check class="size-4 shrink-0" />{/if}
			</button>
			{#snippet failed()}{/snippet}
		</svelte:boundary>
	{/each}
</section>
