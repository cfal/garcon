<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import type { ConversationFeedMessageRenderItem } from '$lib/chat/transcript/conversation-feed-items.js';
	import { summarizeToolUses } from '$lib/chat/tools/tool-use-summary.js';
	import { cn } from '$lib/utils/cn';
	import type { ToolGroupVirtualFeedItem } from './conversation-feed-virtual-items.js';

	interface Props {
		item: ToolGroupVirtualFeedItem;
		onToggle: (memberIds: readonly string[], expanded: boolean) => void;
	}

	function messageMembers(group: ToolGroupVirtualFeedItem): ConversationFeedMessageRenderItem[] {
		const messages: ConversationFeedMessageRenderItem[] = [];
		for (const member of group.members) {
			if (member.item.kind === 'message') messages.push(member.item);
		}
		return messages;
	}

	let { item, onToggle }: Props = $props();
	let button: HTMLButtonElement;
	const toolMessages = $derived(messageMembers(item));
	const memberIds = $derived(item.members.map((member) => member.item.id));
	const summary = $derived(summarizeToolUses(toolMessages));

	function toggleGroup(): void {
		if (item.expanded) button.focus({ preventScroll: true });
		onToggle(memberIds, !item.expanded);
	}
</script>

<div class="flow-root">
	<button
		bind:this={button}
		type="button"
		data-chat-tool-group
		data-chat-tool-group-count={summary.count}
		data-chat-anchor-id={item.anchorId}
		aria-label={summary.accessibleLabel}
		aria-expanded={item.expanded}
		onclick={toggleGroup}
		class="flex min-h-11 w-full min-w-0 items-center gap-2 border-y border-border px-2 py-2 text-left text-sm text-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
	>
		<ChevronRight
			class={cn('size-4 shrink-0 transition-transform', item.expanded && 'rotate-90')}
			aria-hidden="true"
		/>
		<span class="min-w-0 break-words">{summary.visibleLabel}</span>
	</button>
	{#if item.spacingAfter === 'transcript'}
		<div aria-hidden="true" class="h-2 sm:h-3"></div>
	{/if}
</div>
