<script lang="ts">
	import { TranscriptNoticeMessage } from '$shared/chat-types';
	import type {
		InterAgentMessageOutcomeNoticeDetail,
		InterAgentMessageReceivedNoticeDetail,
	} from '$shared/transcript-notice-details';
	import MessageSquareReply from '@lucide/svelte/icons/message-square-reply';
	import Send from '@lucide/svelte/icons/send';
	import * as m from '$lib/paraglide/messages.js';
	import { interAgentMessageFailureLabel } from '$lib/chat/transcript/inter-agent-message-presentation';
	import Markdown from '../Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from '../Markdown.svelte';
	import type { ConversationDisclosureStatePort } from '../ConversationFeedItemState.svelte.js';
	import ChatEventCard from './ChatEventCard.svelte';
	import CollapsibleBody from './CollapsibleBody.svelte';

	interface Props {
		message: TranscriptNoticeMessage;
		detail: InterAgentMessageOutcomeNoticeDetail | InterAgentMessageReceivedNoticeDetail;
		resolveChatTitle?: (chatId: string) => string | null | undefined;
		fileLinkBasePath?: string | null;
		onLinkNavigate?: (link: MarkdownLinkNavigateEvent) => boolean | void;
		acquireTransientActivity?: (close: () => void) => () => void;
		disclosureState?: ConversationDisclosureStatePort;
	}

	let {
		message,
		detail,
		resolveChatTitle,
		fileLinkBasePath,
		onLinkNavigate,
		acquireTransientActivity,
		disclosureState,
	}: Props = $props();

	const isOutcome = $derived(detail.type === 'inter-agent-message-outcome');
	const direction = $derived(isOutcome ? 'sent' : 'received');

	function chatLabel(chatId: string): string {
		return resolveChatTitle?.(chatId)?.trim() || chatId;
	}

	function chatLabels(chatIds: readonly string[]): string {
		return chatIds.map(chatLabel).join(', ');
	}

	const displayTitle = $derived.by(() => {
		if (detail.type === 'inter-agent-message-received') {
			return detail.fromChatId === null
				? m.chat_message_inter_agent_received_hidden()
				: m.chat_message_inter_agent_received({ source: chatLabel(detail.fromChatId) });
		}

		const sent = detail.results
			.filter((result) => result.status !== 'failed')
			.map((result) => result.chatId);
		const failed = detail.results
			.filter((result) => result.status === 'failed')
			.map((result) => result.chatId);
		if (sent.length === 0) {
			return m.chat_message_inter_agent_send_failed({ targets: chatLabels(failed) });
		}
		if (failed.length > 0) {
			return m.chat_message_inter_agent_sent_partial({
				sent: chatLabels(sent),
				failed: chatLabels(failed),
			});
		}
		return m.chat_message_inter_agent_sent({ targets: chatLabels(sent) });
	});
	const failedDeliveries = $derived.by(() => {
		if (detail.type !== 'inter-agent-message-outcome') return [];
		return detail.results.flatMap((result) =>
			result.status === 'failed'
				? [
						{
							chatId: result.chatId,
							target: chatLabel(result.chatId),
							reason: interAgentMessageFailureLabel(result.reason),
						},
					]
				: [],
		);
	});
</script>

<div
	class="inter-agent-message-row flex min-w-0 justify-start"
	data-inter-agent-message-direction={direction}
>
	<div class="w-full min-w-0 sm:w-auto sm:max-w-[85%]">
		<ChatEventCard variant="neutral" compact class="inter-agent-message-card">
			{#snippet body()}
				<div class="flex min-w-0 items-center gap-2">
					{#if isOutcome}
						<Send class="size-3.5 shrink-0" aria-hidden="true" />
					{:else}
						<MessageSquareReply class="size-3.5 shrink-0" aria-hidden="true" />
					{/if}
					<span class="min-w-0 flex-1 truncate text-xs font-medium" title={displayTitle}>
						{displayTitle}
					</span>
				</div>
				{#if failedDeliveries.length > 0}
					<ul class="mt-1 space-y-0.5 text-xs">
						{#each failedDeliveries as failure (failure.chatId)}
							<li><span class="font-medium">{failure.target}:</span> {failure.reason}</li>
						{/each}
					</ul>
				{/if}
				<CollapsibleBody
					disclosure="collapsed"
					expanded={disclosureState?.open('notice-body', 'body', false)}
					onExpandedChange={disclosureState
						? (expanded) => disclosureState.setOpen('notice-body', 'body', expanded, false)
						: undefined}
				>
					{#snippet children()}
						<div class="mt-1 text-sm">
							<Markdown
								source={message.content}
								variant="presented"
								fileLinkBasePath={isOutcome ? (fileLinkBasePath ?? undefined) : undefined}
								onLinkNavigate={isOutcome ? onLinkNavigate : undefined}
								{acquireTransientActivity}
							/>
						</div>
					{/snippet}
				</CollapsibleBody>
			{/snippet}
		</ChatEventCard>
	</div>
</div>
