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
	import { composerSelectionTriggerClass } from './selection-trigger';

	let {
		nodes,
		nodeId,
		service,
		onSelect,
		disabled = false,
		presentation = 'toolbar',
		class: className,
	}: {
		nodes: ExecutionNodesStore;
		nodeId: string;
		service: 'files' | 'git' | 'agents';
		onSelect: (nodeId: string) => void;
		disabled?: boolean;
		presentation?: 'toolbar' | 'composer' | 'field';
		class?: string;
	} = $props();

	const nodeLabel = $derived(nodes.label(nodeId));

	function available(id: string): boolean {
		if (service === 'agents') return nodes.isReady(id);
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
				presentation === 'composer' && [composerSelectionTriggerClass, 'composer-node-trigger max-w-36 shrink-0'],
				presentation === 'field' && 'h-10 max-w-full border border-border bg-background px-3 text-base pointer-fine:text-sm',
				className,
			)}
			{disabled}
			title={nodes.get(nodeId) ? nodeLabel : nodeId}
			aria-label={`Execution node: ${nodeLabel}`}
			data-execution-node-picker
			data-presentation={presentation}
		>
			<Network class="size-4 shrink-0 text-file-icon-folder" aria-hidden="true" />
			<span class="node-label min-w-0 truncate">{nodeLabel}</span>
			<ChevronDown class="node-chevron size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		</DropdownMenuTrigger>
		<DropdownMenuContent align="start" class="max-w-[calc(100vw-1rem)]">
			<DropdownMenuRadioGroup value={nodeId}>
				{#if !nodes.get(nodeId)}
					<DropdownMenuRadioItem value={nodeId} disabled class="text-sm" title={nodeId}>
						<span class="min-w-0 max-w-64 break-words">{nodeLabel}</span>
						{#if !nodes.hasSnapshot}<span class="text-muted-foreground">Unavailable</span>{/if}
					</DropdownMenuRadioItem>
				{/if}
				{#each nodes.nodes as node (node.id)}
					<svelte:boundary>
						{@const nodeAvailable = available(node.id)}
						<DropdownMenuRadioItem
							value={node.id}
							disabled={!nodeAvailable}
							onSelect={() => { if (available(node.id)) onSelect(node.id); }}
							class="min-h-9 text-sm"
						>
							<span class="min-w-0 max-w-64 break-words">{node.label}</span>
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

<style>
	@container composer-controls (max-width: 42rem) {
		:global(.composer-node-trigger) {
			width: 2.25rem;
			padding-inline: 0;
			justify-content: center;
		}
		:global(.composer-node-trigger .node-label),
		:global(.composer-node-trigger .node-chevron) {
			display: none;
		}
	}
</style>
