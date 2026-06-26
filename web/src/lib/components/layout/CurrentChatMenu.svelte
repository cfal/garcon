<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import Edit2 from '@lucide/svelte/icons/pencil';
	import Info from '@lucide/svelte/icons/info';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Share2 from '@lucide/svelte/icons/share-2';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { cn } from '$lib/utils/cn';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface CurrentChatMenuProps {
		selectedChat: ChatSessionRecord;
		isMobileLayout: boolean;
		splitEnabled: boolean;
		isDesktopFullscreen: boolean;
		canToggleDesktopFullscreen: boolean;
		canReload: boolean;
		canUpdateProjectPath: boolean;
		shadow?: boolean;
		onToggleSplitMode: () => void;
		onToggleDesktopFullscreen?: () => void;
		onRename: () => void;
		onDetails: () => void;
		onReload: () => void;
		onShare: () => void;
		onProjectPath: () => void;
		onDelete: () => void;
	}

	let {
		selectedChat,
		isMobileLayout,
		splitEnabled,
		isDesktopFullscreen,
		canToggleDesktopFullscreen,
		canReload,
		canUpdateProjectPath,
		shadow = false,
		onToggleSplitMode,
		onToggleDesktopFullscreen,
		onRename,
		onDetails,
		onReload,
		onShare,
		onProjectPath,
		onDelete,
	}: CurrentChatMenuProps = $props();

	const splitLabel = $derived(splitEnabled ? m.workspace_exit_split_view() : m.workspace_split_view());
	const fullscreenLabel = $derived(
		isDesktopFullscreen ? m.main_exit_fullscreen() : m.main_enter_fullscreen(),
	);
	const triggerLabel = $derived(
		isMobileLayout ? m.current_chat_options() : m.sidebar_chat_more_actions(),
	);
	const railClass = $derived(
		cn(
			'relative flex shrink-0 rounded-lg border border-chat-tabs-rail-border bg-chat-tabs-rail p-0.5 text-foreground',
			shadow ? 'shadow-sm' : '',
		),
	);
	const triggerClass = $derived(
		cn(
			'relative inline-flex h-8 shrink-0 items-center justify-center rounded-md text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground sm:text-sm',
			isMobileLayout ? 'gap-1.5 px-2' : 'w-8 px-0',
		),
	);
</script>

<DropdownMenu>
	<div class={railClass}>
		<DropdownMenuTrigger class={triggerClass} aria-label={triggerLabel}>
			{#if isMobileLayout}
				<span>{triggerLabel}</span>
			{/if}
			<EllipsisVertical class="h-3.5 w-3.5" />
		</DropdownMenuTrigger>
	</div>
	<DropdownMenuContent align="end">
		{#if !isMobileLayout}
			<DropdownMenuItem onclick={onToggleSplitMode}>
				<PanelLeft />
				{splitLabel}
			</DropdownMenuItem>
			{#if canToggleDesktopFullscreen}
				<DropdownMenuItem onclick={onToggleDesktopFullscreen}>
					{#if isDesktopFullscreen}
						<Minimize2 />
					{:else}
						<Maximize2 />
					{/if}
					{fullscreenLabel}
				</DropdownMenuItem>
			{/if}
			<DropdownMenuSeparator />
		{/if}

		<DropdownMenuItem onclick={onRename}>
			<Edit2 />
			{m.sidebar_tooltips_edit_chat_name()}
		</DropdownMenuItem>
		<DropdownMenuItem onclick={onDetails}>
			<Info />
			{m.sidebar_chats_details()}
		</DropdownMenuItem>
		{#if canReload}
			<DropdownMenuItem
				disabled={selectedChat.isProcessing}
				onclick={() => {
					if (!selectedChat.isProcessing) onReload();
				}}
			>
				<RefreshCw />
				{m.sidebar_chats_reload()}
			</DropdownMenuItem>
		{/if}
		<DropdownMenuItem onclick={onShare}>
			<Share2 />
			{m.share_button()}
		</DropdownMenuItem>
		{#if canUpdateProjectPath}
			<DropdownMenuItem
				disabled={selectedChat.isProcessing}
				onclick={() => {
					if (!selectedChat.isProcessing) onProjectPath();
				}}
			>
				<FolderOpen />
				{m.sidebar_project_path_menu_item()}
			</DropdownMenuItem>
		{/if}
		<DropdownMenuSeparator />
		<DropdownMenuItem variant="destructive" onclick={onDelete}>
			<Trash2 />
			{m.sidebar_tooltips_delete_chat()}
		</DropdownMenuItem>
	</DropdownMenuContent>
</DropdownMenu>
