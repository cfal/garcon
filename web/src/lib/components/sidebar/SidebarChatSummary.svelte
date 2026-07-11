<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import ChatAgentTags from '../shared/ChatAgentTags.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { cn } from '$lib/utils/cn';
	import { formatSidebarChatTimestamp } from './chat-timestamp.js';
	import { formatSidebarProjectPath } from './sidebar-project-path-display';

	interface SidebarChatSummaryProps {
		session: ChatSessionRecord;
		isSelected: boolean;
		isPinned: boolean;
		isArchived: boolean;
		currentTime?: Date;
		showTimestamp?: boolean;
		showProjectPath?: boolean;
		compactChatItem?: boolean;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
	}

	let {
		session,
		isSelected,
		currentTime = new Date(),
		showTimestamp = false,
		showProjectPath = true,
		compactChatItem = false,
		onTagClick,
		onManageTags,
	}: SidebarChatSummaryProps = $props();

	let isUnread = $derived(session.isUnread && !isSelected);
	let chatName = $derived(session.title || m.sidebar_chats_new_chat());
	let lastMessage = $derived(session.lastMessage || '');
	let projectPath = $derived(showProjectPath ? session.projectPath || '' : '');
	let agentId = $derived(session.agentId || 'claude');
	let activityTimestamp = $derived(session.lastActivityAt ?? session.createdAt);
	let formattedTimestamp = $derived(
		showTimestamp ? formatSidebarChatTimestamp(activityTimestamp, currentTime) : null,
	);

	let displayProjectPath = $derived(formatSidebarProjectPath(projectPath));
</script>

<div class="relative min-w-0 w-full" data-slot="sidebar-chat-summary">
	<div class="min-w-0 flex-1">
		<div
			class={cn(
				'flex min-w-0 items-center gap-1.5 truncate text-[14px] font-medium leading-[1.3]',
				isSelected ? 'text-sidebar-chat-item-selected-foreground' : 'text-foreground',
			)}
		>
			{#if isUnread}
				<span
					class="h-1.5 w-1.5 shrink-0 rounded-full bg-indicator-unread"
					aria-label={m.sidebar_chat_unread()}
				></span>
			{/if}
			<span class="truncate">{chatName}</span>
		</div>

		{#if projectPath || formattedTimestamp}
			<div
				class={cn(
					'mt-0.5 flex min-w-0 items-baseline gap-1 overflow-hidden text-[12px] leading-[1.3]',
					isSelected ? 'text-sidebar-chat-item-selected-foreground/80' : 'text-muted-foreground',
				)}
			>
				{#if projectPath}
					<span class="min-w-0 truncate font-semibold" title={projectPath}>
						{displayProjectPath}
					</span>
				{/if}
				{#if projectPath && formattedTimestamp}
					<span class="shrink-0 font-normal" aria-hidden="true">{'\u2022'}</span>
				{/if}
				{#if formattedTimestamp}
					<span
						class={cn(
							'shrink-0 whitespace-nowrap font-normal tabular-nums',
							isSelected
								? 'text-sidebar-chat-item-selected-foreground/75'
								: 'text-muted-foreground',
						)}
						title={formattedTimestamp.tooltip}
					>
						{formattedTimestamp.label}
					</span>
				{/if}
			</div>
		{/if}

		{#if !compactChatItem}
			<div
				class={cn(
					'mb-1 mt-0.5 truncate text-[13px] italic',
					isSelected ? 'text-sidebar-chat-item-selected-foreground/90' : 'text-foreground/80',
				)}
			>
				{lastMessage || '\u00A0'}
			</div>
		{/if}

		<ChatAgentTags
			{agentId}
			tags={session.tags}
			class="mt-1"
			{onTagClick}
			onManageTags={onManageTags ? () => onManageTags(session.id, session.tags) : undefined}
		/>
	</div>
</div>
