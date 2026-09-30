<script lang="ts">
	import type { Snippet } from 'svelte';
	import Network from '@lucide/svelte/icons/network';
	import * as m from '$lib/paraglide/messages.js';
	import ChatAgentTags from '../shared/ChatAgentTags.svelte';
	import ChatProcessingIndicator from './ChatProcessingIndicator.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import { cn } from '$lib/utils/cn';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp.js';
	import { formatCompactProjectPath } from '$lib/chat/project-paths/compact-project-path';

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
	let projectPath = $derived(showProjectPath ? session.projectPath?.trim() || '' : '');
	let agentId = $derived(session.agentId || 'claude');
	let activityTimestamp = $derived(session.lastActivityAt ?? session.createdAt);
	let formattedTimestamp = $derived(
		showTimestamp ? formatRelativeTimestamp(activityTimestamp, currentTime) : null,
	);
	let selectedForeground = $derived(isSidebar && isSelected);
	let titleClass = $derived(
		isSidebar ? 'min-w-0 truncate' : 'min-w-0 line-clamp-2 whitespace-normal break-words',
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
			isSidebar ? 'truncate' : 'mb-1 mt-0.5 line-clamp-2 min-h-[2.4em] whitespace-pre-wrap break-words',
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
		<span class={cn(titleClass, isUnread ? 'font-bold' : 'font-medium')} title={chatName}>
			{chatName}
		</span>
		{#if isUnread}
			<span class="sr-only" data-slot="sidebar-chat-unread-status">
				{m.sidebar_chat_unread()}
			</span>
		{/if}
		{@render titleBadge?.()}
		{#if !isSidebar && !isSingleLine}
			<ChatProcessingIndicator
				phase={session.isProcessing ? (session.processingPhase ?? 'running') : null}
				label={m.chat_window_processing()}
				dotSlot="chat-board-processing-indicator"
			/>
		{:else if session.isProcessing}
			<span class={cn('flex items-center justify-end pr-0.5', headerStatusClass)}>
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
					headerStatusClass,
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
