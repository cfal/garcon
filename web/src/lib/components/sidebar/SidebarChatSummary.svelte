<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import ChatAgentTags from '../shared/ChatAgentTags.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { SidebarChatItemLayout } from '$lib/stores/local-settings.svelte';
	import { cn } from '$lib/utils/cn';
	import { formatSidebarChatTimestamp } from './chat-timestamp.js';
	import { formatSidebarProjectPath } from './sidebar-project-path-display';

	interface SidebarChatSummaryProps {
		session: ChatSessionRecord;
		isSelected: boolean;
		suppressUnread?: boolean;
		currentTime?: Date;
		showTimestamp?: boolean;
		showProjectPath?: boolean;
		chatItemLayout?: SidebarChatItemLayout;
		onTagClick?: (tag: string) => void;
		onManageTags?: () => void;
	}

	let {
		session,
		isSelected,
		suppressUnread,
		currentTime = new Date(),
		showTimestamp = false,
		showProjectPath = true,
		chatItemLayout = 'default',
		onTagClick,
		onManageTags,
	}: SidebarChatSummaryProps = $props();

	let isUnread = $derived(session.isUnread && !(suppressUnread ?? isSelected));
	let isProcessing = $derived(session.isProcessing);
	let isSingleLine = $derived(chatItemLayout === 'single-line');
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

<div
	class={cn('relative min-w-0', isSingleLine ? 'flex-1' : 'w-full')}
	data-slot="sidebar-chat-summary"
>
	{#if isSingleLine}
		<div
			class={cn(
				'flex min-w-0 w-full items-center gap-1.5 text-[14px] leading-[1.3]',
				isSelected ? 'text-sidebar-chat-item-selected-foreground' : 'text-foreground',
			)}
		>
			<span class={cn('min-w-0 flex-1 truncate', isUnread ? 'font-bold' : 'font-medium')}>
				{chatName}
			</span>
			{#if isUnread}
				<span class="sr-only" data-slot="sidebar-chat-unread-status">
					{m.sidebar_chat_unread()}
				</span>
			{/if}
			{#if isProcessing}
				<span class="sr-only">{m.chat_pane_processing()}</span>
				<span
					class="sidebar-processing-indicator size-2 shrink-0 rounded-full bg-status-processing"
					aria-hidden="true"
					data-slot="sidebar-chat-processing-indicator"
				></span>
			{:else if formattedTimestamp}
				<span
					class={cn(
						'shrink-0 whitespace-nowrap rounded-full border px-1.5 text-[11px] leading-4 tabular-nums',
						isSelected
							? 'border-sidebar-chat-item-selected-foreground/25 bg-sidebar-chat-item-selected-foreground/10 text-sidebar-chat-item-selected-foreground/80'
							: 'border-border/70 bg-muted/40 text-muted-foreground',
					)}
					title={formattedTimestamp.tooltip}
					data-slot="sidebar-chat-timestamp-badge"
				>
					{formattedTimestamp.label}
				</span>
			{/if}
		</div>
	{:else}
		<div class="min-w-0 flex-1">
			<div
				class={cn(
					'flex min-w-0 items-center gap-1.5 text-[14px] leading-[1.3]',
					isSelected ? 'text-sidebar-chat-item-selected-foreground' : 'text-foreground',
				)}
			>
				<span class={cn('min-w-0 truncate', isUnread ? 'font-bold' : 'font-medium')}>
					{chatName}
				</span>
				{#if isUnread}
					<span class="sr-only" data-slot="sidebar-chat-unread-status">
						{m.sidebar_chat_unread()}
					</span>
				{/if}
				{#if isProcessing}
					<span class="sr-only">{m.chat_pane_processing()}</span>
				{/if}
				{#if isProcessing}
					<span
						class="sidebar-processing-indicator size-2 shrink-0 rounded-full bg-status-processing"
						aria-hidden="true"
						data-slot="sidebar-chat-processing-indicator"
					></span>
				{/if}
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

			{#if chatItemLayout !== 'compact'}
				<div
					class={cn(
						'mb-1 mt-0.5 truncate text-[13px] italic',
						isUnread ? 'font-semibold' : 'font-normal',
						isSelected ? 'text-sidebar-chat-item-selected-foreground/90' : 'text-foreground/80',
					)}
				>
					{lastMessage || '\u00A0'}
				</div>
			{/if}

			<ChatAgentTags {agentId} tags={session.tags} class="mt-1" {onTagClick} {onManageTags} />
		</div>
	{/if}
</div>
