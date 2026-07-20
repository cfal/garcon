<script lang="ts">
	// Renders a context-compaction boundary: a divider summarizing what the agent
	// preserved when it summarized earlier history to free up context. Token
	// counts are shown when the provider reports them, and the generated summary
	// is available behind an expand toggle.

	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Layers from '@lucide/svelte/icons/layers';
	import type { CompactionMessage } from '$shared/chat-types';
	import ChatEventCard from './rows/ChatEventCard.svelte';
	import Markdown from './Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from './Markdown.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		message: CompactionMessage;
		projectBasePath?: string;
		onLinkNavigate?: (link: MarkdownLinkNavigateEvent) => boolean | void;
	}

	let { message, projectBasePath, onLinkNavigate }: Props = $props();

	let open = $state(false);

	const triggerLabel = $derived(
		message.trigger === 'auto'
			? m.chat_message_compaction_auto()
			: m.chat_message_compaction_manual(),
	);

	const tokenLabel = $derived.by(() => {
		if (message.preTokens === undefined || message.postTokens === undefined) return '';
		return m.chat_message_compaction_tokens({
			pre: message.preTokens.toLocaleString(),
			post: message.postTokens.toLocaleString(),
		});
	});

	const hasSummary = $derived(message.summary.trim().length > 0);
</script>

<ChatEventCard variant="info" compact>
	{#snippet body()}
		<div class="flex items-center gap-2">
			<Layers class="h-4 w-4 flex-shrink-0" />
			<span class="text-xs font-medium">{m.chat_message_compacted()}</span>
			<span class="text-xs text-muted-foreground">({triggerLabel})</span>
			{#if tokenLabel}
				<span class="ml-auto text-xs tabular-nums text-muted-foreground">{tokenLabel}</span>
			{/if}
		</div>

		{#if hasSummary}
			<button
				type="button"
				class="mt-1 flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
				onclick={() => {
					open = !open;
				}}
				aria-expanded={open}
			>
				<ChevronRight class="h-3 w-3 transition-transform {open ? 'rotate-90' : ''}" />
				<span
					>{open
						? m.chat_message_compaction_hide_summary()
						: m.chat_message_compaction_show_summary()}</span
				>
			</button>

			{#if open}
				<div class="mt-1 text-sm text-foreground/90">
					<Markdown
						source={message.summary}
						variant="thinking"
						fileLinkBasePath={projectBasePath}
						{onLinkNavigate}
					/>
				</div>
			{/if}
		{/if}
	{/snippet}
</ChatEventCard>
