<script lang="ts">
	import Network from '@lucide/svelte/icons/network';
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
	import { cn } from '$lib/utils/cn';

	let {
		nodes,
		nodeId,
		service,
		onSelect,
		disabled = false,
		class: className,
	}: {
		nodes: ExecutionNodesStore;
		nodeId: string;
		service: 'files' | 'git';
		onSelect: (nodeId: string) => void;
		disabled?: boolean;
		class?: string;
	} = $props();

	const nodeLabel = $derived(nodes.label(nodeId));

	function available(id: string): boolean {
		return service === 'files' ? nodes.filesAvailable(id) : nodes.gitAvailable(id);
	}

	function unavailableLabel(node: ExecutionNodesStore['nodes'][number]): string {
		if (!nodes.isReady(node.id)) return executionNodeStatus(node);
		return service === 'files' ? 'Files unavailable' : 'Git unavailable';
	}
</script>

{#if nodes.hasRemoteNodes || nodeId !== 'local'}
	<DropdownMenu
		onOpenChange={(open) => {
			if (open) void nodes.refresh();
		}}
	>
		<DropdownMenuTrigger
			class={cn(
				'inline-flex h-8 min-w-0 max-w-40 items-center gap-1.5 rounded-lg px-2 text-xs font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
				className,
			)}
			{disabled}
			title={nodeLabel}
			aria-label={`Execution node: ${nodeLabel}`}
			data-execution-node-picker
		>
			<Network class="size-4 shrink-0 text-file-icon-folder" aria-hidden="true" />
			<span class="min-w-0 truncate">{nodeLabel}</span>
			<ChevronDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		</DropdownMenuTrigger>
		<DropdownMenuContent align="start" class="max-w-[calc(100vw-1rem)]">
			<DropdownMenuRadioGroup value={nodeId}>
				{#each nodes.nodes as node (node.id)}
					<svelte:boundary>
						{@const nodeAvailable = available(node.id)}
						<DropdownMenuRadioItem
							value={node.id}
							disabled={!nodeAvailable}
							onSelect={() => onSelect(node.id)}
							class="text-xs"
						>
							<span class="min-w-0 max-w-64 truncate">{node.label}</span>
							{#if !nodeAvailable}
								<span class="text-muted-foreground">
									{unavailableLabel(node)}
								</span>
							{/if}
						</DropdownMenuRadioItem>
						{#snippet failed()}{/snippet}
					</svelte:boundary>
				{/each}
			</DropdownMenuRadioGroup>
		</DropdownMenuContent>
	</DropdownMenu>
{/if}
