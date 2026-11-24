<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { Button } from '$lib/components/ui/button';
	import {
		DropdownMenu,
		DropdownMenuCheckboxItem,
		DropdownMenuContent,
		DropdownMenuGroup,
		DropdownMenuGroupHeading,
		DropdownMenuItem,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Search from '@lucide/svelte/icons/search';
	import Settings from '@lucide/svelte/icons/settings';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Braces from '@lucide/svelte/icons/braces';
	import ChartSpline from '@lucide/svelte/icons/chart-spline';
	import FileText from '@lucide/svelte/icons/file-text';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import SquareCheck from '@lucide/svelte/icons/square-check';
	import PanelsTopLeft from '@lucide/svelte/icons/panels-top-left';
	import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import type { SidebarSortMode } from '$lib/stores/local-settings.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';
	import NativeServerChooserItem from './NativeServerChooserItem.svelte';
	import NativeTitlebarItem from './NativeTitlebarItem.svelte';

	interface SidebarControlsRowProps {
		isLoading: boolean;
		visibleUnreadCount?: number;
		onShowDisplay?: (returnFocus: () => void) => void;
		sortMode?: SidebarSortMode;
		chatListAutohide?: boolean;
		chatListAutohideAvailable?: boolean;
		dockOnRight?: boolean;
		sidebarMenuSearches?: SavedChatSearch[];
		hasAdjacentSearchContext?: boolean;
		onOpenSearchDialog: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onTileWorkingChats?: () => void;
		onSetSortMode?: (mode: SidebarSortMode) => void;
		onToggleChatListAutohide?: () => void;
		onSetDockOnRight?: (enabled: boolean) => void;
		onApplySidebarMenuSearch?: (query: string) => void;
		onShowScheduledPrompts: () => void;
		onShowPreambles: () => void;
		onShowSnippets: () => void;
		onShowUsage: () => void;
		onShowSettings: () => void;
	}

	let {
		isLoading,
		visibleUnreadCount = 0,
		onShowDisplay,
		sortMode = 'recent',
		chatListAutohide = false,
		chatListAutohideAvailable = false,
		dockOnRight = false,
		sidebarMenuSearches = [],
		hasAdjacentSearchContext = false,
		onOpenSearchDialog,
		onCreateChat,
		onMarkAllRead,
		onTileWorkingChats,
		onSetSortMode,
		onToggleChatListAutohide,
		onSetDockOnRight,
		onApplySidebarMenuSearch,
		onShowScheduledPrompts,
		onShowPreambles,
		onShowSnippets,
		onShowUsage,
		onShowSettings,
	}: SidebarControlsRowProps = $props();

	let buttonLabel = $derived(m.sidebar_chats_new_chat());
	let showMarkAllRead = $derived(visibleUnreadCount > 0);
	let showQuickSearchSeparator = $derived(sidebarMenuSearches.length > 0);
	let showDockDivider = $derived(!hasAdjacentSearchContext);
	let primaryButtonRef = $state<HTMLButtonElement | null>(null);
	let menuTrigger = $state<HTMLButtonElement | null>(null);
	function showDisplay(): void {
		const target = menuTrigger;
		onShowDisplay?.(() => {
			if (
				target?.isConnected &&
				(!document.activeElement || document.activeElement === document.body)
			)
				target.focus();
		});
	}
	let primaryButtonWidth = $state(0);
	let showPrimaryLabel = $derived(primaryButtonWidth === 0 || primaryButtonWidth >= 136);

	$effect(() => {
		if (!primaryButtonRef || typeof ResizeObserver === 'undefined') return;

		const resizeObserver = new ResizeObserver((entries) => {
			primaryButtonWidth = entries[0]?.contentRect.width ?? 0;
		});

		resizeObserver.observe(primaryButtonRef);
		return () => resizeObserver.disconnect();
	});
</script>

<div
	data-slot="sidebar-controls-row"
	class={`flex-shrink-0 ${showDockDivider ? 'border-b' : ''} border-border/60 bg-card px-2 py-2`}
>
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
				bind:ref={menuTrigger}
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
				<DropdownMenuItem onclick={onTileWorkingChats} disabled={!onTileWorkingChats || isLoading}>
					<PanelsTopLeft class="h-3.5 w-3.5" />
					{m.sidebar_chats_tile_working()}
				</DropdownMenuItem>
				<DropdownMenuItem onclick={onMarkAllRead} disabled={!showMarkAllRead || isLoading}>
					<SquareCheck class="h-3.5 w-3.5" />
					{m.sidebar_chats_mark_all_read()}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuGroupHeading>
						{m.sidebar_chats_sort_order_heading()}
					</DropdownMenuGroupHeading>
					<DropdownMenuRadioGroup
						value={sortMode}
						onValueChange={(mode) => onSetSortMode?.(mode as SidebarSortMode)}
					>
						<DropdownMenuRadioItem value="manual">
							{m.sidebar_chats_sort_order_manual()}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="recent">
							{m.sidebar_chats_sort_recent_active()}
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem onclick={showDisplay}>
					<Settings class="h-3.5 w-3.5" />
					{m.sidebar_display_title()}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuCheckboxItem
					checked={chatListAutohide}
					disabled={!chatListAutohideAvailable}
					onCheckedChange={() => onToggleChatListAutohide?.()}
				>
					<PanelLeftClose class="h-3.5 w-3.5" />
					{m.sidebar_actions_autohide_sidebar()}
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={dockOnRight}
					onCheckedChange={(enabled) => onSetDockOnRight?.(enabled)}
				>
					<PanelRight class="h-3.5 w-3.5" />
					{m.sidebar_actions_dock_sidebar_right()}
				</DropdownMenuCheckboxItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onclick={onShowScheduledPrompts}>
					<CalendarClock class="h-3.5 w-3.5" />
					{m.sidebar_actions_scheduled_prompts()}
				</DropdownMenuItem>
				<DropdownMenuItem onclick={onShowPreambles}>
					<FileText class="h-3.5 w-3.5" />
					{m.sidebar_actions_preambles()}
				</DropdownMenuItem>
				<DropdownMenuItem onclick={onShowSnippets}>
					<Braces class="h-3.5 w-3.5" />
					{m.snippets_title()}
				</DropdownMenuItem>
				<DropdownMenuItem onclick={onShowUsage}>
					<ChartSpline class="h-3.5 w-3.5" />
					{m.workspace_surface_usage()}
				</DropdownMenuItem>
				<DropdownMenuItem onclick={onShowSettings}>
					<Settings class="h-3.5 w-3.5" />
					{m.settings_title()}
				</DropdownMenuItem>
				<NativeServerChooserItem />
				<NativeTitlebarItem />
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
</div>
