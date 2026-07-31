<script lang="ts">
	import Edit2 from '@lucide/svelte/icons/pencil';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import GitFork from '@lucide/svelte/icons/git-fork';
	import GitCompareArrows from '@lucide/svelte/icons/git-compare-arrows';
	import History from '@lucide/svelte/icons/history';
	import Info from '@lucide/svelte/icons/info';
	import ListIcon from '@lucide/svelte/icons/list';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { DropdownMenuItem, DropdownMenuSeparator } from '$lib/components/ui/dropdown-menu';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import * as m from '$lib/paraglide/messages.js';

	let {
		selectedChat,
		canReload,
		canUpdateProjectPath,
		canFork,
		canForkNow,
		onOpenUserMessageNavigator,
		onOpenGitHistory,
		onOpenGitCompare,
		onRename,
		onDetails,
		onReload,
		onShare,
		onProjectPath,
		onFork,
		onDelete,
	}: {
		selectedChat: ChatSessionRecord;
		canReload: boolean;
		canUpdateProjectPath: boolean;
		canFork: boolean;
		canForkNow: boolean;
		onOpenUserMessageNavigator?: () => void;
		onOpenGitHistory?: () => void;
		onOpenGitCompare?: () => void;
		onRename: () => void;
		onDetails: () => void;
		onReload: () => void;
		onShare: () => void;
		onProjectPath: () => void;
		onFork: () => void;
		onDelete: () => void;
	} = $props();
</script>

{#if onOpenGitHistory || onOpenGitCompare}
	{#if onOpenGitHistory}
		<DropdownMenuItem onclick={onOpenGitHistory}>
			<History />
			{m.workspace_open_git_history()}
		</DropdownMenuItem>
	{/if}
	{#if onOpenGitCompare}
		<DropdownMenuItem onclick={onOpenGitCompare}>
			<GitCompareArrows />
			{m.workspace_open_git_compare()}
		</DropdownMenuItem>
	{/if}
	<DropdownMenuSeparator />
{/if}

{#if onOpenUserMessageNavigator}
	<DropdownMenuItem onclick={onOpenUserMessageNavigator}>
		<ListIcon />
		{m.chat_user_message_navigator_menu()}
	</DropdownMenuItem>
{/if}
<DropdownMenuItem onclick={onShare}>
	<Share2 />
	{m.share_button()}
</DropdownMenuItem>
<DropdownMenuItem onclick={onDetails}>
	<Info />
	{m.sidebar_chats_details()}
</DropdownMenuItem>
{#if canFork}
	<DropdownMenuItem disabled={!canForkNow} onclick={() => canForkNow && onFork()}>
		<GitFork />
		{m.sidebar_chats_fork()}
	</DropdownMenuItem>
{/if}
<DropdownMenuItem onclick={onRename}>
	<Edit2 />
	{m.sidebar_tooltips_edit_chat_name()}
</DropdownMenuItem>
{#if canUpdateProjectPath}
	<DropdownMenuItem
		disabled={selectedChat.isProcessing}
		onclick={() => !selectedChat.isProcessing && onProjectPath()}
	>
		<FolderOpen />
		{m.sidebar_project_path_menu_item()}
	</DropdownMenuItem>
{/if}
{#if canReload}
	<DropdownMenuItem
		disabled={selectedChat.isProcessing}
		onclick={() => !selectedChat.isProcessing && onReload()}
	>
		<RefreshCw />
		{m.sidebar_chats_reload()}
	</DropdownMenuItem>
{/if}
<DropdownMenuSeparator />
<DropdownMenuItem variant="destructive" onclick={onDelete}>
	<Trash2 />
	{m.sidebar_tooltips_delete_chat()}
</DropdownMenuItem>
