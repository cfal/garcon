<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import type { GroupDescriptor } from '$shared/transcript-display-contract';
	import { summarizeToolCounts } from '$lib/chat/tools/tool-use-summary.js';
	import { cn } from '$lib/utils/cn';
	import type { ToolGroupVirtualFeedItem } from './conversation-feed-virtual-items.js';

	interface Props {
		item: ToolGroupVirtualFeedItem;
		onToggle: (group: GroupDescriptor, expanded: boolean) => void;
	}

	let { item, onToggle }: Props = $props();
	let button: HTMLButtonElement;
	const summary = $derived(summarizeToolCounts(item.descriptor.count, item.descriptor.totals, item.descriptor.categoryOrder));

	function toggleGroup(): void {
		if (item.expanded) button.focus({ preventScroll: true });
		onToggle(item.descriptor, !item.expanded);
	}
</script>

<div class="flow-root">
	<button
		bind:this={button}
		type="button"
		data-chat-tool-group
		data-chat-tool-group-count={summary.count}
		data-chat-anchor-id={item.anchorId}
		aria-expanded={item.expanded}
		onclick={toggleGroup}
		class="typography-chat-prose flex w-full min-w-0 items-center gap-1.5 text-left text-sm italic text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
	>
		<span class="relative h-4 w-2 shrink-0" aria-hidden="true">
			<ChevronRight
				class={cn(
					'absolute -left-1 top-0 size-4 transition-transform',
					item.expanded && 'rotate-90',
				)}
			/>
		</span>
		<span class="min-w-0 break-words">{summary.label}</span>
	</button>
	{#if item.expanded || item.spacingAfter === 'transcript'}
		<div aria-hidden="true" class="h-2 sm:h-3"></div>
	{/if}
</div>
