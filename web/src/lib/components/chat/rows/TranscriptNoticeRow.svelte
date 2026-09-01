<script lang="ts">
	// Renders a durable transcript notice. Handoff summaries collapse by default
	// behind the shared clamp so very long summaries stay bounded, while the
	// server-supplied title remains visible for orientation.
	import { TranscriptNoticeMessage } from '$shared/chat-types';
	import {
		isChatIdDiscoveryFailureNoticeDetail,
		isHandoffSummaryNoticeDetail,
		isInterAgentMessageOutcomeNoticeDetail,
		isInterAgentMessageReceivedNoticeDetail,
	} from '$shared/transcript-notice-details';
	import ChatEventCard from './ChatEventCard.svelte';
	import CollapsibleBody from './CollapsibleBody.svelte';
	import InterAgentMessageRow from './InterAgentMessageRow.svelte';
	import Markdown from '../Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from '../Markdown.svelte';
	import type { ConversationDisclosureStatePort } from '../ConversationFeedItemState.svelte.js';

	interface Props {
		message: TranscriptNoticeMessage;
		resolveChatTitle?: (chatId: string) => string | null | undefined;
		fileLinkBasePath?: string | null;
		onLinkNavigate?: (link: MarkdownLinkNavigateEvent) => boolean | void;
		acquireTransientActivity?: (close: () => void) => () => void;
		disclosureState?: ConversationDisclosureStatePort;
	}

	let {
		message,
		resolveChatTitle,
		fileLinkBasePath,
		onLinkNavigate,
		acquireTransientActivity,
		disclosureState,
	}: Props = $props();

	const isHandoffSummary = $derived(isHandoffSummaryNoticeDetail(message.detail));
	const isChatIdDiscoveryFailure = $derived(isChatIdDiscoveryFailureNoticeDetail(message.detail));
	const interAgentDetail = $derived.by(() => {
		if (isInterAgentMessageOutcomeNoticeDetail(message.detail)) return message.detail;
		if (isInterAgentMessageReceivedNoticeDetail(message.detail)) return message.detail;
		return null;
	});
</script>

{#if interAgentDetail}
	<InterAgentMessageRow
		{message}
		detail={interAgentDetail}
		{resolveChatTitle}
		{fileLinkBasePath}
		{onLinkNavigate}
		{acquireTransientActivity}
		{disclosureState}
	/>
{:else}
	<ChatEventCard variant={isChatIdDiscoveryFailure ? 'error' : 'info'}>
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
					<div class={['text-sm', message.title && 'mt-1']}>
						<Markdown
							source={message.content}
							variant="presented"
							fileLinkBasePath={fileLinkBasePath ?? undefined}
							{onLinkNavigate}
							{acquireTransientActivity}
						/>
					</div>
				</CollapsibleBody>
			{:else}
				<div class={['text-sm whitespace-pre-wrap break-words', message.title && 'mt-1']}>
					{message.content}
				</div>
			{/if}
		{/snippet}
	</ChatEventCard>
{/if}
