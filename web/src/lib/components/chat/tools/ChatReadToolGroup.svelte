<script lang="ts">
	import type { ReadToolUseMessage } from '$shared/chat-types';
	import ChatEventCard from '../rows/ChatEventCard.svelte';
	import {
		buildReadToolGroupRenderItems,
		summarizeReadToolGroup,
	} from '$lib/chat/read-tool-group-items';

	interface Props {
		messages: ReadToolUseMessage[];
		onFileOpen?: (filePath: string) => void;
	}

	let { messages, onFileOpen }: Props = $props();

	const summary = $derived(summarizeReadToolGroup(messages));
	const renderItems = $derived(buildReadToolGroupRenderItems(messages));

	function handleFileOpen(filePath: string): void {
		if (!filePath) return;
		onFileOpen?.(filePath);
	}
</script>

<div class="group my-0.5">
	<ChatEventCard variant="default" compact>
		{#snippet body()}
			<div class="mb-1.5 flex items-center gap-2 min-w-0">
				<span class="text-[11px] font-medium text-muted-foreground tracking-wide">Read</span>
				<span class="text-[11px] text-muted-foreground">{summary.label}</span>
			</div>

			<div class="divide-y divide-border/70">
				{#each renderItems as item (item.key)}
					<div class="py-1 first:pt-0 last:pb-0 min-w-0">
						<div class="flex items-center gap-1.5 min-w-0">
							{#if item.isUnknown || !onFileOpen}
								<span
									class="text-xs font-mono truncate min-w-0 {item.isUnknown
										? 'text-muted-foreground italic'
										: 'text-foreground'}"
									title={item.filePath || item.displayName}
								>
									{item.displayName}
								</span>
							{:else}
								<button
									type="button"
									onclick={() => handleFileOpen(item.filePath)}
									class="text-xs text-primary hover:text-primary/80 font-mono hover:underline transition-colors truncate text-left min-w-0"
									title={item.filePath}
								>
									{item.displayName}
								</button>
							{/if}
						</div>
						{#if item.rangeLabel}
							<div class="mt-0.5 text-[11px] text-muted-foreground break-words">
								{item.rangeLabel}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/snippet}
	</ChatEventCard>
</div>
