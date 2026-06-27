<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { ContextMenuItem } from '$lib/components/ui/context-menu';
	import Copy from '@lucide/svelte/icons/copy';
	import GitFork from '@lucide/svelte/icons/git-fork';
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import TextSelect from '@lucide/svelte/icons/text-select';

	interface Props {
		canFork?: boolean;
		onFork?: (event: MouseEvent) => void;
		onCopy: () => void | Promise<void>;
		onSendToNewSession: () => void;
		onSelectText: () => void;
	}

	let {
		canFork = false,
		onFork,
		onCopy,
		onSendToNewSession,
		onSelectText,
	}: Props = $props();
</script>

{#if canFork && onFork}
	<ContextMenuItem onclick={onFork}>
		<GitFork />
		{m.chat_message_fork()}
	</ContextMenuItem>
{/if}

<ContextMenuItem onclick={onCopy}>
	<Copy />
	{m.chat_message_copy_text()}
</ContextMenuItem>

<ContextMenuItem onclick={onSendToNewSession}>
	<SquareArrowOutUpRight />
	{m.chat_message_send_to_new_session()}
</ContextMenuItem>

<ContextMenuItem class="chat-message-touch-menu-item" onclick={onSelectText}>
	<TextSelect />
	{m.chat_message_select_text()}
</ContextMenuItem>
