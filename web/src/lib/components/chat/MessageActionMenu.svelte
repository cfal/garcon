<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { ContextMenuItem } from '$lib/components/ui/context-menu';
	import Copy from '@lucide/svelte/icons/copy';
	import GitFork from '@lucide/svelte/icons/git-fork';
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import TextSelect from '@lucide/svelte/icons/text-select';

	interface Props {
		canFork?: boolean;
		canForkNow?: boolean;
		onFork?: (event: MouseEvent) => void;
		onCopy: () => void | Promise<void>;
		onSendToNewSession: () => void;
		onSelectText: () => void;
	}

	let {
		canFork = false,
		canForkNow = true,
		onFork,
		onCopy,
		onSendToNewSession,
		onSelectText,
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
	<ContextMenuItem disabled={!canForkNow} onclick={handleFork}>
		<GitFork />
		{m.chat_message_fork()}
	</ContextMenuItem>
{/if}

<ContextMenuItem onclick={onSendToNewSession}>
	<SquareArrowOutUpRight />
	{m.chat_message_send_to_new_session()}
</ContextMenuItem>
