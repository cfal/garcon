<script lang="ts">
	import { TranscriptNoticeMessage } from '$shared/chat-types';
	import type {
		InterAgentMessageOutcomeNoticeDetail,
		InterAgentMessageReceivedNoticeDetail,
	} from '$shared/transcript-notice-details';
	import Check from '@lucide/svelte/icons/check';
	import MessageSquareReply from '@lucide/svelte/icons/message-square-reply';
	import Send from '@lucide/svelte/icons/send';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
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
	const displayTitle = $derived(
		isOutcome
			? m.chat_message_inter_agent_sent_title()
			: m.chat_message_inter_agent_received_title(),
	);
	const participantLabel = $derived(
		isOutcome ? m.chat_message_inter_agent_to() : m.chat_message_inter_agent_from(),
	);

	function chatParticipant(chatId: string) {
		const title = resolveChatTitle?.(chatId)?.trim();
		return {
			label: title || chatId,
			chatId: title && title !== chatId ? chatId : null,
		};
	}

	const participants = $derived.by(() => {
		if (detail.type === 'inter-agent-message-received') {
			if (detail.fromChatId !== null) {
				return [{ ...chatParticipant(detail.fromChatId), status: null }];
			}
			return [
				{
					label: m.chat_message_inter_agent_sender_hidden(),
					chatId: null,
					status: null,
				},
			];
		}

		return detail.results.map((result) => ({
			...chatParticipant(result.chatId),
			status: result.status === 'failed' ? ('failed' as const) : ('sent' as const),
		}));
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
					<span class="min-w-0 flex-1 truncate text-sm font-medium" title={displayTitle}>
						{displayTitle}
					</span>
				</div>
				<div class="mt-2">
					<div class="text-xs font-medium text-muted-foreground">{participantLabel}</div>
					<ul class="mt-1 space-y-1.5">
						{#each participants as participant}
							<li class="flex min-w-0 items-center gap-1.5 leading-5">
								<span class="min-w-0 truncate text-sm" title={participant.label}>
									{participant.label}
								</span>
								{#if participant.chatId}
									<span class="shrink-0 text-[11px] text-muted-foreground/80">
										({participant.chatId})
									</span>
								{/if}
								{#if participant.status === 'failed'}
									<span
										class="inline-flex shrink-0 text-status-error-foreground"
										aria-label={m.chat_message_inter_agent_send_failed()}
										title={m.chat_message_inter_agent_send_failed()}
									>
										<X class="size-3.5" aria-hidden="true" />
									</span>
								{:else if participant.status === 'sent'}
									<span
										class="inline-flex shrink-0 text-status-success-foreground"
										aria-label={m.chat_message_inter_agent_send_succeeded()}
										title={m.chat_message_inter_agent_send_succeeded()}
									>
										<Check class="size-3.5" aria-hidden="true" />
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
				<div class="inter-agent-message-divider -mx-3 mt-2 border-t border-border"></div>
				<CollapsibleBody
					disclosure="collapsed"
					expanded={disclosureState?.open('notice-body', 'body', false)}
					onExpandedChange={disclosureState
						? (expanded) => disclosureState.setOpen('notice-body', 'body', expanded, false)
						: undefined}
				>
					{#snippet children()}
						<div class="pt-2 text-sm">
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
