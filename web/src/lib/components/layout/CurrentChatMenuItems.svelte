<script lang="ts">
	import Columns2 from '@lucide/svelte/icons/columns-2';
	import Edit2 from '@lucide/svelte/icons/pencil';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import GitFork from '@lucide/svelte/icons/git-fork';
	import Info from '@lucide/svelte/icons/info';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import ListIcon from '@lucide/svelte/icons/list';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { DropdownMenuItem, DropdownMenuSeparator } from '$lib/components/ui/dropdown-menu';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import * as m from '$lib/paraglide/messages.js';

	let {
		selectedChat,
		showSplitViewAction,
		showFullscreenAction,
		splitEnabled,
		isDesktopFullscreen,
		canReload,
		canUpdateProjectPath,
		canFork,
		canForkNow,
		onToggleSplitMode,
		onToggleDesktopFullscreen,
		onOpenUserMessageNavigator,
		onRename,
		onDetails,
		onReload,
		onShare,
		onProjectPath,
		onFork,
		onDelete,
	}: {
		selectedChat: ChatSessionRecord;
		showSplitViewAction: boolean;
		showFullscreenAction: boolean;
		splitEnabled: boolean;
		isDesktopFullscreen: boolean;
		canReload: boolean;
		canUpdateProjectPath: boolean;
		canFork: boolean;
		canForkNow: boolean;
		onToggleSplitMode: () => void;
		onToggleDesktopFullscreen?: () => void;
		onOpenUserMessageNavigator?: () => void;
		onRename: () => void;
		onDetails: () => void;
		onReload: () => void;
		onShare: () => void;
		onProjectPath: () => void;
		onFork: () => void;
		onDelete: () => void;
	} = $props();

	const splitLabel = $derived(
		splitEnabled ? m.workspace_exit_split_view() : m.workspace_split_view(),
	);
	const fullscreenLabel = $derived(
		isDesktopFullscreen ? m.main_exit_fullscreen() : m.main_enter_fullscreen(),
	);
</script>

{#if showSplitViewAction || showFullscreenAction}
	{#if showSplitViewAction}
		<DropdownMenuItem onclick={onToggleSplitMode}>
			<Columns2 />
			{splitLabel}
		</DropdownMenuItem>
	{/if}
	{#if showFullscreenAction}
		<DropdownMenuItem onclick={onToggleDesktopFullscreen}>
			{#if isDesktopFullscreen}<Minimize2 />{:else}<Maximize2 />{/if}
			{fullscreenLabel}
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
