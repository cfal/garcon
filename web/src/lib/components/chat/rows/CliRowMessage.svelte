<script lang="ts">
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import type { CliPresentationStyle } from '@garcon/common/cli-presentation';
	import {
		cliPresentationCardVariant,
		cliPresentationLabel,
	} from '$lib/chat/transcript/cli-presentation-style';
	import ChatEventCard from './ChatEventCard.svelte';

	interface Props {
		style: CliPresentationStyle;
		title?: string;
		content: string;
	}

	let { style, title, content }: Props = $props();
	const label = $derived(cliPresentationLabel(style));
</script>

<ChatEventCard
	variant={cliPresentationCardVariant(style)}
	compact
	class="cli-row-message cli-row-message-{style}"
>
	{#snippet body()}
		<div class="flex min-w-0 items-center gap-2">
			<SquareTerminal class="size-3.5 shrink-0" aria-hidden="true" />
			{#if title}<span class="sr-only">{label}</span>{/if}
			<span class="min-w-0 flex-1 truncate text-xs font-medium">{title ?? label}</span>
		</div>
		<div class="mt-1 whitespace-pre-wrap break-words text-sm">{content}</div>
	{/snippet}
</ChatEventCard>
