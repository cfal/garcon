<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import type { ChatMapController } from '$lib/chat-map/chat-map-controller.svelte';
	import type { ChatMapNode } from '$lib/chat-map/chat-map-model';
	import Self from './ChatMapBranch.svelte';
	import ChatMapChatCard from './ChatMapChatCard.svelte';
	import ChatMapMissingParentCard from './ChatMapMissingParentCard.svelte';

	interface ChatMapBranchProps {
		node: ChatMapNode;
		controller: ChatMapController;
		selectedChatId: string | null;
		currentTime: Date;
		searchActive: boolean;
		root?: boolean;
	}

	let {
		node,
		controller,
		selectedChatId,
		currentTime,
		searchActive,
		root = false,
	}: ChatMapBranchProps = $props();

	const hasChildren = $derived(node.children.length > 0);
	const expanded = $derived(searchActive || !controller.collapsedNodeKeys.has(node.key));
	const branchTitle = $derived(
		node.kind === 'chat'
			? node.chat.title || m.sidebar_chats_unnamed()
			: m.chat_map_missing_parent(),
	);
</script>

<li
	class={cn(
		'relative min-w-[16rem]',
		!root &&
			'before:absolute before:-left-6 before:top-5 before:w-6 before:border-t before:border-border',
	)}
	data-chat-map-node={node.key}
>
	<div class="flex min-w-0 items-start gap-1.5">
		{#if hasChildren}
			<button
				type="button"
				class="mt-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
				aria-expanded={expanded}
				aria-label={expanded
					? m.chat_map_collapse_branch({ title: branchTitle })
					: m.chat_map_expand_branch({ title: branchTitle })}
				disabled={searchActive}
				onclick={() => controller.toggleNode(node.key)}
			>
				{#if expanded}
					<ChevronDown class="size-4" aria-hidden="true" />
				{:else}
					<ChevronRight class="size-4" aria-hidden="true" />
				{/if}
			</button>
		{:else}
			<span class="w-7 shrink-0" aria-hidden="true"></span>
		{/if}

		{#if node.kind === 'chat'}
			<ChatMapChatCard {node} {selectedChatId} {currentTime} {searchActive} />
		{:else}
			<ChatMapMissingParentCard {node} />
		{/if}
	</div>

	{#if hasChildren && expanded}
		<ul class="ml-3 mt-3 space-y-3 border-l border-border pl-6">
			{#each node.children as child (child.key)}
				<svelte:boundary>
					<Self node={child} {controller} {selectedChatId} {currentTime} {searchActive} />
					{#snippet failed()}
						<li
							class="rounded-md border border-status-error-border bg-status-error/10 px-3 py-2 text-xs text-status-error-foreground"
						>
							{m.chat_map_node_render_failed()}
						</li>
					{/snippet}
				</svelte:boundary>
			{/each}
		</ul>
	{/if}
</li>
