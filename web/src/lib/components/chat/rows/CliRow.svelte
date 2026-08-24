<script lang="ts">
	import type { CliRowMessage } from '$shared/chat-types';
	import { cliPresentationSurfaceClass } from '$lib/chat/transcript/cli-presentation-style';
	import { cn } from '$lib/utils/cn';
	import Markdown from '../Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from '../Markdown.svelte';
	import ChatEventCard from './ChatEventCard.svelte';
	import CliPresentationHeader from './CliPresentationHeader.svelte';

	interface Props {
		message: CliRowMessage;
		fileLinkBasePath?: string | null;
		onLinkNavigate?: (link: MarkdownLinkNavigateEvent) => boolean | void;
		acquireTransientActivity?: (close: () => void) => () => void;
	}

	let {
		message,
		fileLinkBasePath,
		onLinkNavigate,
		acquireTransientActivity,
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
			<CliPresentationHeader
				style={message.presentation.style}
				title={message.title}
			/>
			{#if message.format === 'markdown'}
				<div class="mt-1 text-sm">
					<Markdown
						source={message.content}
						variant="assistant"
						fileLinkBasePath={fileLinkBasePath ?? undefined}
						{onLinkNavigate}
						{acquireTransientActivity}
					/>
				</div>
			{:else}
				<div class="mt-1 whitespace-pre-wrap break-words text-sm">{message.content}</div>
			{/if}
		{/snippet}
	</ChatEventCard>
</div>
