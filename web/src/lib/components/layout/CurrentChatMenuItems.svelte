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
	import {
		dropdownMenuPrimitives,
		type MenuPrimitives,
	} from '$lib/components/ui/menu-primitives.js';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import * as m from '$lib/paraglide/messages.js';

	let {
		menu = dropdownMenuPrimitives,
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
		menu?: MenuPrimitives;
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
		<menu.Item onSelect={onOpenGitHistory}>
			<History />
			{m.workspace_open_git_history()}
		</menu.Item>
	{/if}
	{#if onOpenGitCompare}
		<menu.Item onSelect={onOpenGitCompare}>
			<GitCompareArrows />
			{m.workspace_open_git_compare()}
		</menu.Item>
	{/if}
	<menu.Separator />
{/if}

{#if onOpenUserMessageNavigator}
	<menu.Item onSelect={onOpenUserMessageNavigator}>
		<ListIcon />
		{m.chat_user_message_navigator_menu()}
	</menu.Item>
{/if}
<menu.Item onSelect={onShare}>
	<Share2 />
	{m.share_button()}
</menu.Item>
<menu.Item onSelect={onDetails}>
	<Info />
	{m.sidebar_chats_details()}
</menu.Item>
{#if canFork}
	<menu.Item disabled={!canForkNow} onSelect={() => canForkNow && onFork()}>
		<GitFork />
		{m.sidebar_chats_fork()}
	</menu.Item>
{/if}
<menu.Item onSelect={onRename}>
	<Edit2 />
	{m.sidebar_tooltips_edit_chat_name()}
</menu.Item>
{#if canUpdateProjectPath}
	<menu.Item
		disabled={selectedChat.isProcessing}
		onSelect={() => !selectedChat.isProcessing && onProjectPath()}
	>
		<FolderOpen />
		{m.sidebar_project_path_menu_item()}
	</menu.Item>
{/if}
{#if canReload}
	<menu.Item
		disabled={selectedChat.isProcessing}
		onSelect={() => !selectedChat.isProcessing && onReload()}
	>
		<RefreshCw />
		{m.sidebar_chats_reload()}
	</menu.Item>
{/if}
<menu.Separator />
<menu.Item variant="destructive" onSelect={onDelete}>
	<Trash2 />
	{m.sidebar_tooltips_delete_chat()}
</menu.Item>
