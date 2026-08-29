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
	import Clock from '@lucide/svelte/icons/clock';
	import SquareCheck from '@lucide/svelte/icons/square-check';
	import PanelsTopLeft from '@lucide/svelte/icons/panels-top-left';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import GitCompareArrows from '@lucide/svelte/icons/git-compare-arrows';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import History from '@lucide/svelte/icons/history';
	import Files from '@lucide/svelte/icons/files';
	import type { SidebarChatItemLayout } from '$lib/stores/local-settings.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';
	import type { PortableSingletonKind } from '$lib/workspace/surface-types.js';
	import type { WorkspaceNewWindowActions } from '$lib/workspace/workspace-new-window-actions.js';

	interface SidebarControlsRowProps {
		isLoading: boolean;
		visibleUnreadCount?: number;
		isMarkingAllRead?: boolean;
		groupByProject?: boolean;
		groupNestedProjectPaths?: boolean;
		chatItemLayout?: SidebarChatItemLayout;
		sortByRecent?: boolean;
		sidebarMenuSearches?: SavedChatSearch[];
		hasAdjacentSearchContext?: boolean;
		onOpenSearchDialog: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onToggleGroupByProject?: () => void;
		onToggleGroupNestedProjectPaths?: () => void;
		onSetChatItemLayout?: (layout: SidebarChatItemLayout) => void;
		onToggleSortByRecent?: () => void;
		onApplySidebarMenuSearch?: (query: string) => void;
		onShowScheduledPrompts: () => void;
		onShowSettings: () => void;
		newWindowActions: WorkspaceNewWindowActions;
	}

	let {
		isLoading,
		visibleUnreadCount = 0,
		isMarkingAllRead = false,
		groupByProject = false,
		groupNestedProjectPaths = false,
		chatItemLayout = 'default',
		sortByRecent = false,
		sidebarMenuSearches = [],
		hasAdjacentSearchContext = false,
		onOpenSearchDialog,
		onCreateChat,
		onMarkAllRead,
		onToggleGroupByProject,
		onToggleGroupNestedProjectPaths,
		onSetChatItemLayout,
		onToggleSortByRecent,
		onApplySidebarMenuSearch,
		onShowScheduledPrompts,
		onShowSettings,
		newWindowActions,
	}: SidebarControlsRowProps = $props();

	let buttonLabel = $derived(m.sidebar_chats_new_chat());
	let showMarkAllRead = $derived(visibleUnreadCount > 0);
	let showQuickSearchSeparator = $derived(sidebarMenuSearches.length > 0);
	let isMarkAllReadDisabled = $derived(isLoading || isMarkingAllRead);
	let showDockDivider = $derived(!hasAdjacentSearchContext);
	let primaryButtonRef = $state<HTMLButtonElement | null>(null);
	let primaryButtonWidth = $state(0);
	let showPrimaryLabel = $derived(primaryButtonWidth === 0 || primaryButtonWidth >= 136);

	const newWindowSingletonLabels: Record<PortableSingletonKind, () => string> = {
		git: m.workspace_surface_git_workbench,
		'git-history': m.workspace_surface_git_history,
		'git-compare': m.workspace_surface_git_compare,
		'pull-requests': m.workspace_surface_pull_requests,
		files: m.workspace_surface_files,
		commit: m.workspace_surface_commit,
	};

	function handleMarkAllRead() {
		onMarkAllRead?.();
	}

	function handleToggleGroupNestedProjectPaths() {
		if (!groupByProject) return;
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
				aria-label={m.workspace_new_window()}
				title={newWindowActions.windowLimitReached
					? m.workspace_drop_zone_max_windows()
					: m.workspace_new_window()}
				data-workspace-new-window-menu
				disabled={newWindowActions.windowLimitReached}
			>
				<PanelsTopLeft class="h-4 w-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" class="w-56">
				<DropdownMenuItem
					disabled={newWindowActions.windowLimitReached || newWindowActions.terminalLimitReached}
					title={newWindowActions.windowLimitReached
						? m.workspace_drop_zone_max_windows()
						: newWindowActions.terminalLimitReached
							? m.terminal_limit_reached()
							: undefined}
					onclick={newWindowActions.createTerminal}
				>
					<SquareTerminal class="h-3.5 w-3.5" />
					{newWindowActions.terminalLimitReached
						? m.terminal_limit_reached()
						: m.workspace_new_terminal()}
				</DropdownMenuItem>
				{#each newWindowActions.singletonKinds as kind (kind)}
					<DropdownMenuItem
						disabled={newWindowActions.windowLimitReached}
						onclick={() => newWindowActions.openSingleton(kind)}
					>
						{#if kind === 'git'}<GitBranch class="h-3.5 w-3.5" />
						{:else if kind === 'git-history'}<History class="h-3.5 w-3.5" />
						{:else if kind === 'git-compare'}<GitCompareArrows class="h-3.5 w-3.5" />
						{:else if kind === 'pull-requests'}<GitPullRequest class="h-3.5 w-3.5" />
						{:else if kind === 'files'}<Files class="h-3.5 w-3.5" />
						{:else}<GitCommitHorizontal class="h-3.5 w-3.5" />{/if}
						{m.workspace_open_surface({ surface: newWindowSingletonLabels[kind]() })}
					</DropdownMenuItem>
				{/each}
			</DropdownMenuContent>
		</DropdownMenu>

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
				<DropdownMenuItem
					onclick={handleMarkAllRead}
					disabled={!showMarkAllRead || isMarkAllReadDisabled}
				>
					<SquareCheck class="h-3.5 w-3.5" />
					{m.sidebar_chats_mark_all_read()}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuCheckboxItem
					checked={sortByRecent}
					onCheckedChange={() => onToggleSortByRecent?.()}
				>
					<Clock class="h-3.5 w-3.5" />
					{m.sidebar_chats_sort_by_recent()}
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={groupByProject}
					onCheckedChange={() => onToggleGroupByProject?.()}
				>
					<FolderTree class="h-3.5 w-3.5" />
					{m.settings_sidebar_group_by_project()}
				</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem
					checked={groupNestedProjectPaths}
					disabled={!groupByProject}
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
