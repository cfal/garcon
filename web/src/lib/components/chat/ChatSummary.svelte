<script lang="ts">
	import type { Snippet } from 'svelte';
	import Network from '@lucide/svelte/icons/network';
	import * as m from '$lib/paraglide/messages.js';
	import ChatAgentTags from '../shared/ChatAgentTags.svelte';
	import ChatActivityIndicator, { type ChatIndicatorStatus } from './ChatActivityIndicator.svelte';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import { cn } from '$lib/utils/cn';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp.js';
	import { formatCompactProjectPath } from '$lib/project-paths/compact-project-path';

	interface ChatSummaryProps {
		session: ChatSessionRecord;
		variant: 'sidebar' | 'board';
		isSelected?: boolean;
		suppressUnread?: boolean;
		currentTime?: Date;
		showTimestamp?: boolean;
		showProjectPath?: boolean;
		executorLabel?: string;
		chatItemLayout?: ChatItemLayout;
		titlePrefix?: Snippet;
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
		executorLabel,
		chatItemLayout = 'detailed',
		titlePrefix,
		titleBadge,
		hasDesktopOverlayMenu = false,
		onTagClick,
		onManageTags,
	}: ChatSummaryProps = $props();

	let isSidebar = $derived(variant === 'sidebar');
	let sidebarIndicatorStatus = $derived.by<ChatIndicatorStatus | null>(() => {
		if (!isSidebar) return null;
		const { isProcessing, activityStatus } = session;
		if (isProcessing) return activityStatus === 'pending-user-action' ? activityStatus : 'working';
		return activityStatus === 'error' ? activityStatus : null;
	});
	let isUnread = $derived(session.isUnread && !(suppressUnread ?? isSelected));
	let isSingleLine = $derived(chatItemLayout === 'single-line');
	let isDetailed = $derived(chatItemLayout === 'detailed');
	let chatName = $derived(session.title || m.sidebar_chats_new_chat());
	let lastMessage = $derived(session.lastMessage || '');
	let projectPath = $derived(showProjectPath ? session.projectPath?.trim() || '' : '');
	let agentId = $derived(session.agentId || 'claude');
	let activityTimestamp = $derived(session.lastActivityAt ?? session.createdAt);
	let formattedTimestamp = $derived(
		showTimestamp ? formatRelativeTimestamp(activityTimestamp, currentTime) : null,
	);
	let headerTimestamp = $derived(
		!session.isProcessing && (isSidebar || isSingleLine) ? formattedTimestamp : null,
	);
	let selectedForeground = $derived(isSidebar && isSelected);
	let titleClass = $derived(
		cn(
			'min-w-0',
			isSidebar ? 'truncate font-normal' : 'line-clamp-2 whitespace-normal break-words font-medium',
			isUnread && 'font-bold',
		),
	);
	let headerStatusClass = $derived(
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

{#snippet preview()}
	<div
		class={cn(
			'text-[13px] italic',
			isSidebar
				? 'truncate'
				: 'mb-1 mt-0.5 line-clamp-2 min-h-[2.4em] whitespace-pre-wrap break-words',
			isUnread ? 'font-semibold' : 'font-normal',
			selectedForeground ? 'text-sidebar-chat-item-selected-foreground/90' : 'text-foreground/80',
		)}
		data-slot="chat-preview"
	>
		{lastMessage || '\u00A0'}
	</div>
{/snippet}

<div
	class={cn('relative w-full min-w-0', isSidebar && 'flex flex-col gap-1')}
	data-slot={isSidebar ? 'sidebar-chat-summary' : 'chat-summary'}
	data-variant={variant}
	data-layout={chatItemLayout}
>
	<div
		class={cn(
			'flex min-w-0 items-center gap-1.5 text-[14px] leading-[1.3]',
			selectedForeground ? 'text-sidebar-chat-item-selected-foreground' : 'text-foreground',
		)}
		data-slot="chat-summary-header"
	>
		{@render titlePrefix?.()}
		<span class={titleClass} title={chatName}>
			{chatName}
		</span>
		{#if isUnread}
			<span class="sr-only" data-slot="sidebar-chat-unread-status">
				{m.sidebar_chat_unread()}
			</span>
		{/if}
		{@render titleBadge?.()}
		{#if !isSidebar && session.isProcessing}
			<span
				class={isSingleLine
					? cn('flex items-center justify-end pr-0.5', headerStatusClass)
					: 'inline-flex'}
			>
				<span class="sr-only">{m.chat_window_processing()}</span>
				<span
					class="size-2 shrink-0 rounded-full bg-status-processing"
					data-phase={session.processingPhase ?? 'running'}
					data-slot="chat-board-processing-indicator"
					aria-hidden="true"
				></span>
			</span>
		{:else if sidebarIndicatorStatus || headerTimestamp}
			<span class={cn('inline-flex items-center gap-1.5', headerStatusClass)}>
				{#if headerTimestamp}
					<span
						class={cn(
							'whitespace-nowrap text-[11px] leading-4 tabular-nums',
							selectedForeground
								? 'text-sidebar-chat-item-selected-foreground/75'
								: 'text-muted-foreground',
						)}
						title={headerTimestamp.tooltip}
						data-slot="sidebar-chat-timestamp-badge"
					>
						{headerTimestamp.label}
					</span>
				{/if}
				{#if sidebarIndicatorStatus}
					<ChatActivityIndicator status={sidebarIndicatorStatus} />
				{/if}
			</span>
		{/if}
	</div>
	{#if isSidebar && projectPath}
		<div
			class={cn(
				'flex min-w-0 items-baseline gap-1 overflow-hidden text-[12px] leading-[1.3]',
				selectedForeground
					? 'text-sidebar-chat-item-selected-foreground/80'
					: 'text-muted-foreground',
			)}
			data-slot="chat-project-path"
		>
			<span class="min-w-0 truncate font-semibold" title={projectPath}>
				{displayProjectPath}
			</span>
		</div>
	{:else if !isSidebar && !isSingleLine && boardMetadata.length > 0}
		<div class="mt-0.5 flex min-w-0 gap-1 overflow-hidden text-[11px] text-muted-foreground">
			{#each boardMetadata as item, index (`${index}:${item}`)}
				{#if index > 0}<span aria-hidden="true">•</span>{/if}
				<span class="truncate">{item}</span>
			{/each}
		</div>
	{/if}

	{#if isDetailed && !isSidebar}
		{@render preview()}
	{/if}

	{#if !isSingleLine}
		<div
			class={cn('flex min-w-0 items-center gap-1', !isSidebar && 'mt-1')}
			data-slot="chat-summary-pills"
		>
			{#if executorLabel}
				<span
					class="inline-flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none text-foreground"
					title={executorLabel}
					data-slot="chat-executor-pill"
				>
					<Network class="size-2.5 shrink-0 text-file-icon-folder" />
					<span class="truncate">{executorLabel}</span>
				</span>
			{/if}
			<ChatAgentTags
				{agentId}
				tags={session.tags}
				tagLimit={agentTagLimit}
				wrap={agentTagsWrap}
				class={isSidebar ? 'min-w-0 overflow-hidden whitespace-nowrap' : 'min-w-0 flex-1'}
				{onTagClick}
				{onManageTags}
			/>
		</div>
	{/if}
	{#if isDetailed && isSidebar}
		{@render preview()}
	{/if}
</div>
