<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import Pin from '@lucide/svelte/icons/pin';
	import Archive from '@lucide/svelte/icons/archive';
	import Edit2 from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ArrowUpToLine from '@lucide/svelte/icons/arrow-up-to-line';
	import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
	import Info from '@lucide/svelte/icons/info';
	import GitFork from '@lucide/svelte/icons/git-fork';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Tag from '@lucide/svelte/icons/tag';
	import CheckSquare from '@lucide/svelte/icons/check-square';
	import {
		DropdownMenuItem,
		DropdownMenuSeparator,
	} from '$lib/components/ui/dropdown-menu';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarChatMenuProps {
		session: ChatSessionRecord;
		isPinned: boolean;
		isArchived: boolean;
		canFork: boolean;
		onEnterMultiSelect?: (chatId: string) => void;
		onMoveToTop?: () => void;
		onMoveToBottom?: () => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onRename: () => void;
		onDetails: () => void;
		onShare: () => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
		onFork: () => void;
		onDelete: () => void;
	}

	let {
		session,
		isPinned,
		isArchived,
		canFork,
		onEnterMultiSelect,
		onMoveToTop,
		onMoveToBottom,
		onTogglePinned,
		onToggleArchive,
		onRename,
		onDetails,
		onShare,
		onManageTags,
		onFork,
		onDelete,
	}: SidebarChatMenuProps = $props();

	const hasSidebarActions = $derived(Boolean(onEnterMultiSelect || onMoveToTop || onMoveToBottom));
</script>

{#if hasSidebarActions}
	{#if onEnterMultiSelect}
		<DropdownMenuItem onclick={() => onEnterMultiSelect?.(session.id)}>
			<CheckSquare />
			{m.sidebar_select_enter()}
		</DropdownMenuItem>
	{/if}
	{#if onMoveToTop}
		<DropdownMenuItem onclick={onMoveToTop}>
			<ArrowUpToLine />
			{m.sidebar_chats_move_to_top()}
		</DropdownMenuItem>
	{/if}
	{#if onMoveToBottom}
		<DropdownMenuItem onclick={onMoveToBottom}>
			<ArrowDownToLine />
			{m.sidebar_chats_move_to_bottom()}
		</DropdownMenuItem>
	{/if}
	<DropdownMenuSeparator />
{/if}

<DropdownMenuItem onclick={() => onTogglePinned(session.id)}>
	<Pin />
	{isPinned ? m.sidebar_chats_unpin() : m.sidebar_chats_pin()}
</DropdownMenuItem>
<DropdownMenuItem onclick={() => onToggleArchive(session.id)}>
	<Archive class={cn(isArchived ? 'text-muted-foreground' : '')} />
	{isArchived ? m.sidebar_chats_unarchive() : m.sidebar_chats_archive()}
</DropdownMenuItem>
<DropdownMenuItem onclick={onRename}>
	<Edit2 />
	{m.sidebar_tooltips_edit_chat_name()}
</DropdownMenuItem>
<DropdownMenuItem onclick={onDetails}>
	<Info />
	{m.sidebar_chats_details()}
</DropdownMenuItem>
<DropdownMenuItem onclick={onShare}>
	<Share2 />
	{m.share_button()}
</DropdownMenuItem>
{#if onManageTags}
	<DropdownMenuItem onclick={() => onManageTags?.(session.id, session.tags)}>
		<Tag />
		{m.sidebar_tags_manage()}
	</DropdownMenuItem>
{/if}
{#if canFork}
	<DropdownMenuItem onclick={onFork}>
		<GitFork />
		{m.sidebar_chats_fork()}
	</DropdownMenuItem>
{/if}
<DropdownMenuSeparator />
<DropdownMenuItem variant="destructive" onclick={onDelete}>
	<Trash2 />
	{m.sidebar_tooltips_delete_chat()}
</DropdownMenuItem>
