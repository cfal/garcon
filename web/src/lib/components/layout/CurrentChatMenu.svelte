<script lang="ts">
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { cn } from '$lib/utils/cn';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import CurrentChatMenuItems from './CurrentChatMenuItems.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface CurrentChatMenuProps {
		selectedChat: ChatSessionRecord;
		isMobileLayout: boolean;
		splitEnabled: boolean;
		canToggleSplitView: boolean;
		isDesktopFullscreen: boolean;
		canToggleDesktopFullscreen: boolean;
		canReload: boolean;
		canUpdateProjectPath: boolean;
		canFork: boolean;
		canForkNow: boolean;
		shadow?: boolean;
		onToggleSplitMode: () => void;
		onToggleDesktopFullscreen?: () => void;
		onRename: () => void;
		onDetails: () => void;
		onReload: () => void;
		onShare: () => void;
		onProjectPath: () => void;
		onFork: () => void;
		onDelete: () => void;
	}

	let {
		selectedChat,
		isMobileLayout,
		splitEnabled,
		canToggleSplitView,
		isDesktopFullscreen,
		canToggleDesktopFullscreen,
		canReload,
		canUpdateProjectPath,
		canFork,
		canForkNow,
		shadow = false,
		onToggleSplitMode,
		onToggleDesktopFullscreen,
		onRename,
		onDetails,
		onReload,
		onShare,
		onProjectPath,
		onFork,
		onDelete,
	}: CurrentChatMenuProps = $props();

	const triggerLabel = $derived(
		isMobileLayout ? m.sidebar_actions_settings() : m.sidebar_chat_more_actions(),
	);
	const railClass = $derived(
		cn(
			'relative flex shrink-0 rounded-lg border border-chat-tabs-rail-border bg-chat-tabs-rail p-0.5 text-foreground',
			shadow ? 'shadow-sm' : '',
		),
	);
	const triggerClass = $derived(
		cn(
			'relative inline-flex h-8 shrink-0 items-center justify-center rounded-md font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground',
			isMobileLayout ? 'w-8 px-0 text-sm' : 'w-8 px-0 text-xs sm:text-sm',
		),
	);
</script>

<DropdownMenu>
	<div class={railClass}>
		<DropdownMenuTrigger class={triggerClass} aria-label={triggerLabel}>
			{#if isMobileLayout}<SettingsIcon class="h-3.5 w-3.5" />{:else}<EllipsisVertical
					class="h-3.5 w-3.5"
				/>{/if}
		</DropdownMenuTrigger>
	</div>
	<DropdownMenuContent align="end">
		<CurrentChatMenuItems
			{selectedChat}
			showSplitViewAction={!isMobileLayout && canToggleSplitView}
			showFullscreenAction={!isMobileLayout && canToggleDesktopFullscreen}
			{splitEnabled}
			{isDesktopFullscreen}
			{canReload}
			{canUpdateProjectPath}
			{canFork}
			{canForkNow}
			{onToggleSplitMode}
			{onToggleDesktopFullscreen}
			{onRename}
			{onDetails}
			{onReload}
			{onShare}
			{onProjectPath}
			{onFork}
			{onDelete}
		/>
	</DropdownMenuContent>
</DropdownMenu>
