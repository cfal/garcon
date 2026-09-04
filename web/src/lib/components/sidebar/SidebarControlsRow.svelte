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
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import FolderTree from '@lucide/svelte/icons/folder-tree';
	import History from '@lucide/svelte/icons/history';
	import Activity from '@lucide/svelte/icons/activity';
	import List from '@lucide/svelte/icons/list';
	import SquareCheck from '@lucide/svelte/icons/square-check';
	import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import type {
		SidebarChatGrouping,
		SidebarChatItemLayout,
		SidebarSortMode,
	} from '$lib/stores/local-settings.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';
	import { sidebarGroupingUsesProjects } from './sidebar-display-options';

	interface SidebarControlsRowProps {
		isLoading: boolean;
		visibleUnreadCount?: number;
		chatGrouping?: SidebarChatGrouping;
		groupNestedProjectPaths?: boolean;
		chatItemLayout?: SidebarChatItemLayout;
		sortMode?: SidebarSortMode;
		chatListAutohide?: boolean;
		chatListAutohideAvailable?: boolean;
		dockOnRight?: boolean;
		sidebarMenuSearches?: SavedChatSearch[];
		hasAdjacentSearchContext?: boolean;
		onOpenSearchDialog: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onSetChatGrouping?: (grouping: SidebarChatGrouping) => void;
		onToggleGroupNestedProjectPaths?: () => void;
		onSetChatItemLayout?: (layout: SidebarChatItemLayout) => void;
		onSetSortMode?: (mode: SidebarSortMode) => void;
		onToggleChatListAutohide?: () => void;
		onSetDockOnRight?: (enabled: boolean) => void;
		onApplySidebarMenuSearch?: (query: string) => void;
		onShowScheduledPrompts: () => void;
		onShowSettings: () => void;
	}

	let {
		isLoading,
		visibleUnreadCount = 0,
		chatGrouping = 'project',
		groupNestedProjectPaths = false,
		chatItemLayout = 'default',
		sortMode = 'manual',
		chatListAutohide = false,
		chatListAutohideAvailable = false,
		dockOnRight = false,
		sidebarMenuSearches = [],
		hasAdjacentSearchContext = false,
		onOpenSearchDialog,
		onCreateChat,
		onMarkAllRead,
		onSetChatGrouping,
		onToggleGroupNestedProjectPaths,
		onSetChatItemLayout,
		onSetSortMode,
		onToggleChatListAutohide,
		onSetDockOnRight,
		onApplySidebarMenuSearch,
		onShowScheduledPrompts,
		onShowSettings,
	}: SidebarControlsRowProps = $props();

	let buttonLabel = $derived(m.sidebar_chats_new_chat());
	let showMarkAllRead = $derived(visibleUnreadCount > 0);
	let showQuickSearchSeparator = $derived(sidebarMenuSearches.length > 0);
	let showDockDivider = $derived(!hasAdjacentSearchContext);
	let groupsByProject = $derived(sidebarGroupingUsesProjects(chatGrouping));
	let primaryButtonRef = $state<HTMLButtonElement | null>(null);
	let primaryButtonWidth = $state(0);
	let showPrimaryLabel = $derived(primaryButtonWidth === 0 || primaryButtonWidth >= 136);

	function handleToggleGroupNestedProjectPaths() {
		if (!groupsByProject) return;
		onToggleGroupNestedProjectPaths?.();
	}

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
				<DropdownMenuGroup>
					<DropdownMenuGroupHeading>
						{m.settings_sidebar_chat_grouping_heading()}
					</DropdownMenuGroupHeading>
					<DropdownMenuRadioGroup
						value={chatGrouping}
						onValueChange={(grouping) => onSetChatGrouping?.(grouping as SidebarChatGrouping)}
					>
						<DropdownMenuRadioItem value="none">
							<List class="h-3.5 w-3.5" />
							{m.settings_sidebar_grouping_none()}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="project">
							<FolderTree class="h-3.5 w-3.5" />
							{m.settings_sidebar_group_by_project()}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="project-and-activity">
							<History class="h-3.5 w-3.5" />
							{m.settings_sidebar_group_by_project_activity()}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="activity">
							<Activity class="h-3.5 w-3.5" />
							{m.settings_sidebar_group_by_activity()}
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
				<DropdownMenuCheckboxItem
					checked={groupNestedProjectPaths}
					disabled={!groupsByProject}
					onCheckedChange={handleToggleGroupNestedProjectPaths}
				>
					<FolderTree class="h-3.5 w-3.5" />
					{m.settings_sidebar_group_nested_project_paths()}
				</DropdownMenuCheckboxItem>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuGroupHeading>
						{m.settings_sidebar_chat_item_layout_heading()}
					</DropdownMenuGroupHeading>
					<DropdownMenuRadioGroup
						value={chatItemLayout}
						onValueChange={(layout) => onSetChatItemLayout?.(layout as SidebarChatItemLayout)}
					>
						<DropdownMenuRadioItem value="default">
							{m.settings_sidebar_chat_item_layout_default()}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="compact">
							{m.settings_sidebar_compact_chat_items()}
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="single-line">
							{m.settings_sidebar_chat_item_layout_single_line()}
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
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
				<DropdownMenuItem onclick={onShowSettings}>
					<Settings class="h-3.5 w-3.5" />
					{m.sidebar_actions_settings()}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
</div>
