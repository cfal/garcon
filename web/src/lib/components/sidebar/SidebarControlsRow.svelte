<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { Button } from '$lib/components/ui/button';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Search from '@lucide/svelte/icons/search';
	import Settings from '@lucide/svelte/icons/settings';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import SquareCheck from '@lucide/svelte/icons/square-check';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarControlsRowProps {
		dockPlacement?: 'top' | 'bottom';
		isLoading: boolean;
		isReorderMode: boolean;
		visibleUnreadCount?: number;
		isMarkingAllRead?: boolean;
		sidebarMenuSearches?: SavedChatSearch[];
		hasAdjacentSearchContext?: boolean;
		onOpenSearchDialog: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onApplySidebarMenuSearch?: (query: string) => void;
		primaryLabel?: string;
		onShowSettings: () => void;
	}

	let {
		dockPlacement = 'bottom',
		isLoading,
		isReorderMode,
		visibleUnreadCount = 0,
		isMarkingAllRead = false,
		sidebarMenuSearches = [],
		hasAdjacentSearchContext = false,
		onOpenSearchDialog,
		onCreateChat,
		onMarkAllRead,
		onApplySidebarMenuSearch,
		primaryLabel,
		onShowSettings,
	}: SidebarControlsRowProps = $props();

	let buttonLabel = $derived(primaryLabel ?? m.sidebar_chats_new_chat());
	let showMarkAllRead = $derived(visibleUnreadCount > 0 && !isReorderMode);
	let showQuickSearchSeparator = $derived(sidebarMenuSearches.length > 0);
	let isMarkAllReadDisabled = $derived(isLoading || isMarkingAllRead);
	let isTopDock = $derived(dockPlacement === 'top');
	let showDockDivider = $derived(!hasAdjacentSearchContext);
	let primaryButtonRef = $state<HTMLButtonElement | null>(null);
	let primaryButtonWidth = $state(0);
	let showPrimaryLabel = $derived(isReorderMode || primaryButtonWidth === 0 || primaryButtonWidth >= 136);

	function handleMarkAllRead() {
		onMarkAllRead?.();
	}

	$effect(() => {
		if (!primaryButtonRef || isReorderMode || typeof ResizeObserver === 'undefined') return;

		const resizeObserver = new ResizeObserver((entries) => {
			primaryButtonWidth = entries[0]?.contentRect.width ?? 0;
		});

		resizeObserver.observe(primaryButtonRef);
		return () => resizeObserver.disconnect();
	});
</script>

<div
	data-slot="sidebar-controls-row"
	class={`flex-shrink-0 ${showDockDivider ? (isTopDock ? 'border-b' : 'border-t') : ''} border-border/60 bg-card px-2 py-2`}
>
	{#if !isReorderMode}
		<div class="flex items-center gap-1.5">
			<button
				type="button"
				bind:this={primaryButtonRef}
				onclick={onCreateChat}
				class="flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border border-sidebar-border/70 bg-muted/50 px-3 text-sm font-medium text-foreground transition-colors hover:bg-background"
				aria-label={buttonLabel}
				title={buttonLabel}
			>
				<MessageSquarePlus class="h-4 w-4 shrink-0" />
				{#if showPrimaryLabel}
					<span class="truncate">{buttonLabel}</span>
				{/if}
			</button>

			<Button
				variant="ghost"
				size="icon-sm"
				class="h-9 w-9 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground"
				onclick={onOpenSearchDialog}
				aria-label={m.sidebar_projects_search_placeholder()}
				title={m.sidebar_projects_search_placeholder()}
			>
				<Search class="h-4 w-4" />
			</Button>

			<DropdownMenu>
				<DropdownMenuTrigger
					class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
					aria-label={m.sidebar_actions_more()}
					title={m.sidebar_actions_more()}
				>
					<EllipsisVertical class="h-3.5 w-3.5" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{#if sidebarMenuSearches.length > 0}
						{#each sidebarMenuSearches as search (search.id)}
							<DropdownMenuItem onclick={() => onApplySidebarMenuSearch?.(search.query)}>
								{search.title || search.query}
							</DropdownMenuItem>
						{/each}
					{/if}
					{#if showQuickSearchSeparator}
						<DropdownMenuSeparator />
					{/if}
					<DropdownMenuItem onclick={handleMarkAllRead} disabled={!showMarkAllRead || isMarkAllReadDisabled}>
						<SquareCheck class="h-3.5 w-3.5" />
						{m.sidebar_chats_mark_all_read()}
					</DropdownMenuItem>
					<DropdownMenuItem onclick={onShowSettings}>
						<Settings class="h-3.5 w-3.5" />
						{m.sidebar_actions_settings()}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	{:else}
			<button
				type="button"
				onclick={onCreateChat}
				class="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-sidebar-border/70 bg-muted/50 px-3 text-sm font-medium text-foreground transition-colors hover:bg-background"
				aria-label={buttonLabel}
				title={buttonLabel}
			>
				<MessageSquarePlus class="h-4 w-4 shrink-0" />
				<span class="truncate">{buttonLabel}</span>
			</button>
		{/if}
</div>
