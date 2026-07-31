<script lang="ts">
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import {
		FLOATING_ICON_TRIGGER_CLASS,
		FLOATING_TOOLBAR_RAIL_CLASS,
	} from '$lib/components/shared/floating-toolbar-styles.js';
	import { cn } from '$lib/utils/cn';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import CurrentChatMenuItems from './CurrentChatMenuItems.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface CurrentChatMenuProps {
		selectedChat: ChatSessionRecord;
		isMobileLayout: boolean;
		canReload: boolean;
		canUpdateProjectPath: boolean;
		canFork: boolean;
		canForkNow: boolean;
		shadow?: boolean;
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
	}

	let {
		selectedChat,
		isMobileLayout,
		canReload,
		canUpdateProjectPath,
		canFork,
		canForkNow,
		shadow = false,
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
	}: CurrentChatMenuProps = $props();

	const triggerLabel = $derived(
		isMobileLayout ? m.sidebar_actions_settings() : m.sidebar_chat_more_actions(),
	);
	const railClass = $derived(cn(FLOATING_TOOLBAR_RAIL_CLASS, !shadow && 'shadow-none'));
</script>

<DropdownMenu>
	<div class={railClass}>
		<DropdownMenuTrigger class={FLOATING_ICON_TRIGGER_CLASS} aria-label={triggerLabel}>
			<EllipsisVertical class="h-3.5 w-3.5" />
		</DropdownMenuTrigger>
	</div>
	<DropdownMenuContent align="end">
		<CurrentChatMenuItems
			{selectedChat}
			{canReload}
			{canUpdateProjectPath}
			{canFork}
			{canForkNow}
			{onOpenUserMessageNavigator}
			{onOpenGitHistory}
			{onOpenGitCompare}
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
