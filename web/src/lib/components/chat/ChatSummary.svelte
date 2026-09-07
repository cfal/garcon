<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import ChatAgentTags from '../shared/ChatAgentTags.svelte';
	import ChatProcessingIndicator from './ChatProcessingIndicator.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import { cn } from '$lib/utils/cn';
	import { formatSidebarChatTimestamp } from '../sidebar/chat-timestamp.js';
	import { formatCompactProjectPath } from '$lib/chat/project-paths/compact-project-path';

	interface ChatSummaryProps {
		session: ChatSessionRecord;
		variant: 'sidebar' | 'board';
		isSelected?: boolean;
		suppressUnread?: boolean;
		currentTime?: Date;
		showTimestamp?: boolean;
		showProjectPath?: boolean;
		chatItemLayout?: ChatItemLayout;
		titleBadge?: Snippet;
		hasDesktopOverlayMenu?: boolean;
		onTagClick?: (tag: string) => void;
		onManageTags?: () => void;
	}

	let {
		session,
		variant,
		isSelected = false,
		suppressUnread,
		currentTime = new Date(),
		showTimestamp = false,
		showProjectPath = true,
		chatItemLayout = 'detailed',
		titleBadge,
		hasDesktopOverlayMenu = false,
		onTagClick,
		onManageTags,
	}: ChatSummaryProps = $props();

	let isSidebar = $derived(variant === 'sidebar');
	let isUnread = $derived(session.isUnread && !(suppressUnread ?? isSelected));
	let isSingleLine = $derived(chatItemLayout === 'single-line');
	let isDetailed = $derived(chatItemLayout === 'detailed');
	let chatName = $derived(session.title || m.sidebar_chats_new_chat());
	let lastMessage = $derived(session.lastMessage || '');
	let projectPath = $derived(showProjectPath ? session.projectPath || '' : '');
	let agentId = $derived(session.agentId || 'claude');
	let activityTimestamp = $derived(session.lastActivityAt ?? session.createdAt);
	let formattedTimestamp = $derived(
		showTimestamp ? formatSidebarChatTimestamp(activityTimestamp, currentTime) : null,
	);
	let selectedForeground = $derived(isSidebar && isSelected);
	let singleLineStatusClass = $derived(
		cn(
			'ml-auto shrink-0',
			hasDesktopOverlayMenu &&
				'mr-6 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:mr-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-0',
		),
	);
	let displayProjectPath = $derived(formatCompactProjectPath(projectPath));
	let boardMetadata = $derived(
		[session.model, formattedTimestamp?.label].filter((value): value is string => Boolean(value)),
	);
	let agentTagsWrap = $derived.by<'flow' | 'none' | 'two-lines'>(() => {
		if (isSidebar) return 'flow';
		if (isDetailed) return 'two-lines';
		return 'none';
	});
	let agentTagLimit = $derived.by(() => {
		if (isSidebar || !isDetailed) return 2;
		return 6;
	});
</script>

<div
	class="relative w-full min-w-0"
	data-slot={isSidebar ? 'sidebar-chat-summary' : 'chat-summary'}
	data-variant={variant}
	data-layout={chatItemLayout}
>
	{#if isSingleLine}
		<div
			class={cn(
				'flex min-w-0 items-center gap-1.5 text-[14px] leading-[1.3]',
				selectedForeground ? 'text-sidebar-chat-item-selected-foreground' : 'text-foreground',
			)}
		>
			<span class={cn('min-w-0 truncate', isUnread ? 'font-bold' : 'font-medium')} title={chatName}>
				{chatName}
			</span>
			{#if isUnread}
				<span class="sr-only" data-slot="sidebar-chat-unread-status">
					{m.sidebar_chat_unread()}
				</span>
			{/if}
			{@render titleBadge?.()}
			{#if session.isProcessing}
				<span class={cn('flex items-center justify-end pr-0.5', singleLineStatusClass)}>
					<ChatProcessingIndicator
						phase={session.processingPhase ?? 'running'}
						label={m.chat_window_processing()}
						dotClass={isSidebar ? 'sidebar-processing-indicator' : undefined}
						dotSlot={isSidebar
							? 'sidebar-chat-processing-indicator'
							: 'chat-board-processing-indicator'}
					/>
				</span>
			{:else if formattedTimestamp}
				<span
					class={cn(
						'whitespace-nowrap rounded-full border px-1.5 text-[11px] leading-4 tabular-nums',
						singleLineStatusClass,
						selectedForeground
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
					selectedForeground ? 'text-sidebar-chat-item-selected-foreground' : 'text-foreground',
				)}
			>
				<span class={cn('min-w-0 truncate', isUnread ? 'font-bold' : 'font-medium')} title={chatName}>
					{chatName}
				</span>
				{#if isUnread}
					<span class="sr-only" data-slot="sidebar-chat-unread-status">
						{m.sidebar_chat_unread()}
					</span>
				{/if}
				<ChatProcessingIndicator
					phase={session.isProcessing ? (session.processingPhase ?? 'running') : null}
					label={m.chat_window_processing()}
					dotClass={isSidebar ? 'sidebar-processing-indicator' : undefined}
					dotSlot={isSidebar
						? 'sidebar-chat-processing-indicator'
						: 'chat-board-processing-indicator'}
				/>
			</div>

			{#if isSidebar && (projectPath || formattedTimestamp)}
				<div
					class={cn(
						'mt-0.5 flex min-w-0 items-baseline gap-1 overflow-hidden text-[12px] leading-[1.3]',
						selectedForeground
							? 'text-sidebar-chat-item-selected-foreground/80'
							: 'text-muted-foreground',
					)}
				>
					{#if projectPath}
						<span class="min-w-0 truncate font-semibold" title={projectPath}>
							{displayProjectPath}
						</span>
					{/if}
					{#if projectPath && formattedTimestamp}
						<span class="shrink-0 font-normal" aria-hidden="true">•</span>
					{/if}
					{#if formattedTimestamp}
						<span
							class={cn(
								'shrink-0 whitespace-nowrap font-normal tabular-nums',
								selectedForeground
									? 'text-sidebar-chat-item-selected-foreground/75'
									: 'text-muted-foreground',
							)}
							title={formattedTimestamp.tooltip}
						>
							{formattedTimestamp.label}
						</span>
					{/if}
				</div>
			{:else if !isSidebar && boardMetadata.length > 0}
				<div class="mt-0.5 flex min-w-0 gap-1 overflow-hidden text-[11px] text-muted-foreground">
					{#each boardMetadata as item, index (`${index}:${item}`)}
						{#if index > 0}<span aria-hidden="true">•</span>{/if}
						<span class="truncate">{item}</span>
					{/each}
				</div>
			{/if}

			{#if isDetailed}
				<div
					class={cn(
						'mb-1 mt-0.5 text-[13px] italic',
						isSidebar ? 'truncate' : 'line-clamp-2 min-h-[2.4em] whitespace-pre-wrap break-words',
						isUnread ? 'font-semibold' : 'font-normal',
						selectedForeground ? 'text-sidebar-chat-item-selected-foreground/90' : 'text-foreground/80',
					)}
				>
					{lastMessage || '\u00A0'}
				</div>
			{/if}

			<ChatAgentTags
				{agentId}
				tags={session.tags}
				tagLimit={agentTagLimit}
				wrap={agentTagsWrap}
				class="mt-1"
				{onTagClick}
				{onManageTags}
			/>
		</div>
	{/if}
</div>
