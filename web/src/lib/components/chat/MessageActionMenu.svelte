<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { ContextMenuItem, ContextMenuSeparator } from '$lib/components/ui/context-menu';
	import Copy from '@lucide/svelte/icons/copy';
	import GitFork from '@lucide/svelte/icons/git-fork';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import TextSelect from '@lucide/svelte/icons/text-select';

	interface Props {
		canFork?: boolean;
		canForkNow?: boolean;
		onFork?: (event: MouseEvent) => void;
		onCopy: () => void | Promise<void>;
		onSendToNewSession: () => void;
		onSelectText: () => void;
		onGenerateTitleFromMessage?: () => void | Promise<void>;
	}

	let {
		canFork = false,
		canForkNow = true,
		onFork,
		onCopy,
		onSendToNewSession,
		onSelectText,
		onGenerateTitleFromMessage,
	}: Props = $props();

	function handleFork(event: MouseEvent): void {
		if (!canForkNow) return;
		onFork?.(event);
	}
</script>

<ContextMenuItem onclick={onCopy}>
	<Copy />
	{m.chat_message_copy_text()}
</ContextMenuItem>

<ContextMenuItem onclick={onSelectText}>
	<TextSelect />
	{m.chat_message_select_text()}
</ContextMenuItem>

{#if canFork && onFork}
	<ContextMenuSeparator />
	<ContextMenuItem disabled={!canForkNow} onclick={handleFork}>
		<GitFork />
		{m.chat_message_fork()}
	</ContextMenuItem>
{/if}

<ContextMenuItem onclick={onSendToNewSession}>
	<SquareArrowOutUpRight />
	{m.chat_message_send_to_new_session()}
</ContextMenuItem>

{#if onGenerateTitleFromMessage}
	<ContextMenuSeparator />
	<ContextMenuItem onclick={onGenerateTitleFromMessage}>
		<RefreshCw />
		{m.chat_message_generate_title_from_message()}
	</ContextMenuItem>
{/if}
