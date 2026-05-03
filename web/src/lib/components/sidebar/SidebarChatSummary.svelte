<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import ColoredTag from '../shared/ColoredTag.svelte';
	import type { SessionProvider } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { cn } from '$lib/utils/cn';
	import { formatSidebarChatTimestamp } from './chat-timestamp.js';

	interface SidebarChatSummaryProps {
		session: ChatSessionRecord;
		isSelected: boolean;
		isPinned: boolean;
		isArchived: boolean;
		currentTime?: Date;
		showTimestamp?: boolean;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
	}

	let {
		session,
		isSelected,
		currentTime = new Date(),
		showTimestamp = false,
		onTagClick,
		onManageTags,
	}: SidebarChatSummaryProps = $props();

	let isUnread = $derived(session.isUnread && !isSelected);
	let visibleTags = $derived(session.tags.slice(0, 2));
	let overflowCount = $derived(Math.max(0, session.tags.length - 2));
	let chatName = $derived(session.title || m.sidebar_chats_new_chat());
	let lastMessage = $derived(session.lastMessage || '');
	let projectPath = $derived(session.projectPath || '');
	let provider = $derived(session.provider || 'claude');
	let isTagManagementEnabled = $derived(Boolean(onManageTags));
	let activityTimestamp = $derived(session.lastActivityAt ?? session.createdAt);
	let formattedTimestamp = $derived(
		showTimestamp ? formatSidebarChatTimestamp(activityTimestamp, currentTime) : null
	);

	const PROVIDER_TAG_VARIANTS: Record<string, string> = {
		claude: 'border-provider-claude-border bg-provider-claude-bg text-provider-claude-foreground',
		codex: 'border-provider-codex-border bg-provider-codex-bg text-provider-codex-foreground',
		opencode: 'border-provider-opencode-border bg-provider-opencode-bg text-provider-opencode-foreground',
		amp: 'border-provider-amp-border bg-provider-amp-bg text-provider-amp-foreground',
		factory: 'border-provider-factory-border bg-provider-factory-bg text-provider-factory-foreground',
		'direct-openai-compatible': 'border-border bg-muted text-foreground',
	};

	let providerTagVariant = $derived(
		PROVIDER_TAG_VARIANTS[provider] ?? PROVIDER_TAG_VARIANTS.claude
	);
	let providerTagLabel = $derived(
		provider === 'claude' ? m.provider_claude()
			: provider === 'codex' ? m.provider_codex()
			: provider === 'opencode' ? m.provider_opencode()
			: provider === 'amp' ? m.provider_amp()
		: provider === 'factory' ? m.provider_factory()
		: provider === 'direct-openai-compatible' ? 'Direct'
		: provider || m.provider_claude()
	);
	function prefixEllipsis(pathStr: string, maxLen = 40): string {
		if (!pathStr || pathStr.length <= maxLen) return pathStr;
		const segments = pathStr.split('/');
		let result = segments[segments.length - 1];
		for (let i = segments.length - 2; i >= 0; i--) {
			const candidate = segments[i] + '/' + result;
			if (candidate.length + 4 > maxLen) break;
			result = candidate;
		}
		return '\u2026/' + result;
	}

	function handleTagClick(event: MouseEvent, tag: string) {
		event.stopPropagation();
		onTagClick?.(tag);
	}

	function handleOverflowClick(event: MouseEvent) {
		event.stopPropagation();
		onManageTags?.(session.id, session.tags);
	}

	function handleOverflowKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.stopPropagation();
		onManageTags?.(session.id, session.tags);
	}
</script>

<div class="relative min-w-0 w-full" data-slot="sidebar-chat-summary">
	<div class="min-w-0 flex-1">
		<div class="flex min-w-0 items-start gap-2">
			<div
				class={cn(
					'flex min-w-0 flex-1 items-center gap-1.5 truncate text-[14px] font-medium',
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

			{#if formattedTimestamp}
				<div
					class={cn(
						'shrink-0 text-right text-[10px] leading-[1.15] tabular-nums',
						isSelected
							? 'text-sidebar-chat-item-selected-foreground/75'
							: 'text-muted-foreground',
					)}
					title={formattedTimestamp.tooltip}
					aria-label={formattedTimestamp.tooltip}
				>
					<div>{formattedTimestamp.dateLabel}</div>
					<div class="mt-0.5">{formattedTimestamp.timeLabel}</div>
				</div>
			{/if}
		</div>

		{#if projectPath}
			<div
				class={cn(
					'truncate text-[11px]',
					isSelected ? 'text-sidebar-chat-item-selected-foreground/80' : 'text-muted-foreground',
				)}
				title={projectPath}
			>
				{prefixEllipsis(projectPath)}
			</div>
		{/if}

		<div
			class={cn(
				'mb-1 mt-0.5 truncate text-[13px] italic',
				isSelected ? 'text-sidebar-chat-item-selected-foreground/90' : 'text-foreground/80',
			)}
		>
			{lastMessage || '\u00A0'}
		</div>

		<div class="mt-1 flex items-center gap-1">
			<ColoredTag label={providerTagLabel} variant={providerTagVariant} />
			{#each visibleTags as tag (tag)}
				<ColoredTag label={tag} autoColor onclick={onTagClick ? (event) => handleTagClick(event, tag) : undefined} />
			{/each}
			{#if overflowCount > 0}
				{#if isTagManagementEnabled}
					<button
						type="button"
						class="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
						onclick={handleOverflowClick}
						onkeydown={handleOverflowKeydown}
					>
						+{overflowCount}
					</button>
				{:else}
					<span class="text-[10px] text-muted-foreground">+{overflowCount}</span>
				{/if}
			{/if}
		</div>
	</div>
</div>
