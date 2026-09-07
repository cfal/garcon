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
	import { stripLegacyInterAgentOutcomePrefix } from '$lib/chat/transcript/inter-agent-message-presentation';
	import type { ResolveChatReference } from '$lib/chat/transcript/chat-reference.js';
	import * as m from '$lib/paraglide/messages.js';
	import ChatReference from '../ChatReference.svelte';
	import Markdown from '../Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from '../Markdown.svelte';
	import type { ConversationDisclosureStatePort } from '../ConversationFeedItemState.svelte.js';
	import ChatEventCard from './ChatEventCard.svelte';
	import CollapsibleBody from './CollapsibleBody.svelte';

	interface Props {
		message: TranscriptNoticeMessage;
		detail: InterAgentMessageOutcomeNoticeDetail | InterAgentMessageReceivedNoticeDetail;
		resolveChatReference?: ResolveChatReference;
		fileLinkBasePath?: string | null;
		onLinkNavigate?: (link: MarkdownLinkNavigateEvent) => boolean | void;
		acquireTransientActivity?: (close: () => void) => () => void;
		disclosureState?: ConversationDisclosureStatePort;
	}

	let {
		message,
		detail,
		resolveChatReference,
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
	const messageBody = $derived(
		detail.type === 'inter-agent-message-outcome'
			? stripLegacyInterAgentOutcomePrefix(message.content, detail.results)
			: message.content,
	);

	const participants = $derived.by(() => {
		if (detail.type === 'inter-agent-message-received') {
			if (detail.fromChatId !== null) {
				return [{ chatId: detail.fromChatId, status: null }];
			}
			return [{ chatId: null, status: null }];
		}

		return detail.results.map((result) => ({
			chatId: result.chatId,
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
					<span class="min-w-0 flex-1 truncate text-xs font-medium" title={displayTitle}>
						{displayTitle}
					</span>
				</div>
				<div
					class="inter-agent-message-participants mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2"
				>
					<div class="text-xs font-medium leading-5 text-muted-foreground">{participantLabel}</div>
					<ul class="min-w-0 space-y-1.5">
						{#each participants as participant, index (index)}
							<li class="flex min-w-0 items-center gap-1.5 leading-5">
								{#if participant.chatId}
									<ChatReference
										chatId={participant.chatId}
										resolution={resolveChatReference?.(participant.chatId) ?? null}
										class="inline-flex min-w-0 items-center gap-1.5"
										linkClass="text-primary hover:underline"
										titleClass="min-w-0 truncate text-sm"
										idClass="shrink-0 text-[11px] text-muted-foreground/80"
										inertTooltipPolicy="always"
									/>
								{:else}
									<span
										class="min-w-0 truncate text-sm"
										title={m.chat_message_inter_agent_sender_hidden()}
									>
										{m.chat_message_inter_agent_sender_hidden()}
									</span>
								{/if}
								{#if participant.status === 'failed'}
									<span
										class="inline-flex shrink-0 text-status-error-foreground"
										role="img"
										aria-label={m.chat_message_inter_agent_send_failed()}
										title={m.chat_message_inter_agent_send_failed()}
									>
										<X class="size-3.5" aria-hidden="true" />
									</span>
								{:else if participant.status === 'sent'}
									<span
										class="inline-flex shrink-0 text-status-success-foreground"
										role="img"
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
					<div class="pt-2 text-sm">
						<Markdown
							source={messageBody}
							variant="presented"
							fileLinkBasePath={isOutcome ? (fileLinkBasePath ?? undefined) : undefined}
							onLinkNavigate={isOutcome ? onLinkNavigate : undefined}
							{resolveChatReference}
							chatReferencePolicy="explicit"
							{acquireTransientActivity}
						/>
					</div>
				</CollapsibleBody>
			{/snippet}
		</ChatEventCard>
	</div>
</div>
