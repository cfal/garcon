<script lang="ts">
	import type { CliRowMessage } from '$shared/chat-types';
	import { cliPresentationSurfaceClass } from '$lib/chat/transcript/cli-presentation-style';
	import { cn } from '$lib/utils/cn';
	import Markdown from '../Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from '../Markdown.svelte';
	import ChatEventCard from './ChatEventCard.svelte';
	import CliPresentationHeader from './CliPresentationHeader.svelte';
	import CollapsibleBody from './CollapsibleBody.svelte';
	import type { ConversationDisclosureStatePort } from '../ConversationFeedItemState.svelte.js';

	interface Props {
		message: CliRowMessage;
		fileLinkBasePath?: string | null;
		onLinkNavigate?: (link: MarkdownLinkNavigateEvent) => boolean | void;
		acquireTransientActivity?: (close: () => void) => () => void;
		alwaysExpanded?: boolean;
		disclosureState?: ConversationDisclosureStatePort;
	}

	let {
		message,
		fileLinkBasePath,
		onLinkNavigate,
		acquireTransientActivity,
		alwaysExpanded = false,
		disclosureState,
	}: Props = $props();
	const customStyle = $derived(
		message.presentation.style === 'custom' ? message.presentation.customStyle : null,
	);
</script>

<div
	style:--cli-presentation-accent-light={customStyle?.lightAccent}
	style:--cli-presentation-accent-dark={customStyle?.darkAccent}
>
	<ChatEventCard
		variant="neutral"
		compact
		class={cn(
			'cli-row-message',
			`cli-row-message-${message.presentation.style}`,
			cliPresentationSurfaceClass(message.presentation.style),
		)}
	>
		{#snippet body()}
			<CliPresentationHeader style={message.presentation.style} title={message.title} />
			<CollapsibleBody
				disclosure={message.disclosure}
				{alwaysExpanded}
				expanded={disclosureState?.open('cli-body', 'body', false)}
				onExpandedChange={disclosureState
					? (expanded) => disclosureState.setOpen('cli-body', 'body', expanded, false)
					: undefined}
			>
				{#snippet children()}
					{#if message.format === 'markdown'}
						<div class="mt-1 text-sm">
							<Markdown
								source={message.content}
								variant="presented"
								fileLinkBasePath={fileLinkBasePath ?? undefined}
								{onLinkNavigate}
								{acquireTransientActivity}
							/>
						</div>
					{:else}
						<div class="mt-1 whitespace-pre-wrap break-words text-sm">{message.content}</div>
					{/if}
				{/snippet}
			</CollapsibleBody>
		{/snippet}
	</ChatEventCard>
</div>
