<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import {
		executionNodeStatus,
		type ExecutionNodesStore,
	} from '$lib/execution-nodes/execution-nodes-store.svelte.js';

	let {
		nodes,
		nodeId,
		onSelect,
	}: {
		nodes: ExecutionNodesStore;
		nodeId: string;
		onSelect: (nodeId: string) => void;
	} = $props();
</script>

<DropdownMenu
	onOpenChange={(open) => {
		if (open) void nodes.refresh();
	}}
>
	<DropdownMenuTrigger
		class="inline-flex min-w-0 max-w-[35%] shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		title={nodes.label(nodeId)}
		aria-label={`Execution node: ${nodes.label(nodeId)}`}
		data-file-node-picker
	>
		<span class="truncate">{nodes.label(nodeId)}</span>
		<ChevronDown class="size-3 shrink-0" aria-hidden="true" />
	</DropdownMenuTrigger>
	<DropdownMenuContent align="start" class="max-w-[calc(100vw-1rem)]">
		<DropdownMenuRadioGroup value={nodeId} onValueChange={onSelect}>
			{#each nodes.nodes as node (node.id)}
				<svelte:boundary>
					<DropdownMenuRadioItem
						value={node.id}
						disabled={!nodes.filesAvailable(node.id)}
						class="text-xs"
					>
						<span class="min-w-0 max-w-64 truncate">{node.label}</span>
						{#if !nodes.filesAvailable(node.id)}
							<span class="text-muted-foreground"
								>{nodes.isReady(node.id) ? 'Files unavailable' : executionNodeStatus(node)}</span
							>
						{/if}
					</DropdownMenuRadioItem>
					{#snippet failed()}{/snippet}
				</svelte:boundary>
			{/each}
		</DropdownMenuRadioGroup>
	</DropdownMenuContent>
</DropdownMenu>
