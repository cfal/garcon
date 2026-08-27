<script lang="ts">
	// Renders a durable transcript notice. Handoff summaries collapse by default
	// behind the shared clamp so very long summaries stay bounded, while the
	// server-supplied title remains visible for orientation.
	import { isHandoffSummaryNoticeDetail, TranscriptNoticeMessage } from '$shared/chat-types';
	import ChatEventCard from './ChatEventCard.svelte';
	import CollapsibleBody from './CollapsibleBody.svelte';
	import Markdown from '../Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from '../Markdown.svelte';
	import type { ConversationDisclosureStatePort } from '../ConversationFeedItemState.svelte.js';

	interface Props {
		message: TranscriptNoticeMessage;
		fileLinkBasePath?: string | null;
		onLinkNavigate?: (link: MarkdownLinkNavigateEvent) => boolean | void;
		acquireTransientActivity?: (close: () => void) => () => void;
		disclosureState?: ConversationDisclosureStatePort;
	}

	let {
		message,
		fileLinkBasePath,
		onLinkNavigate,
		acquireTransientActivity,
		disclosureState,
	}: Props = $props();

	const isHandoffSummary = $derived(isHandoffSummaryNoticeDetail(message.detail));
</script>

<ChatEventCard variant="info">
	{#snippet body()}
		{#if message.title}
			<div class="min-w-0 truncate text-xs font-medium">{message.title}</div>
		{/if}
		{#if isHandoffSummary}
			<CollapsibleBody
				disclosure="collapsed"
				expanded={disclosureState?.open('notice-body', 'body', false)}
				onExpandedChange={disclosureState
					? (expanded) => disclosureState.setOpen('notice-body', 'body', expanded, false)
					: undefined}
			>
				{#snippet children()}
					<div class={['text-sm', message.title && 'mt-1']}>
						<Markdown
							source={message.content}
							variant="presented"
							fileLinkBasePath={fileLinkBasePath ?? undefined}
							{onLinkNavigate}
							{acquireTransientActivity}
						/>
					</div>
				{/snippet}
			</CollapsibleBody>
		{:else}
			<div class={['text-sm whitespace-pre-wrap break-words', message.title && 'mt-1']}>
				{message.content}
			</div>
		{/if}
	{/snippet}
</ChatEventCard>
