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
	import SidebarSearchTrigger from './SidebarSearchTrigger.svelte';
	import Settings from '@lucide/svelte/icons/settings';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import SquareCheck from '@lucide/svelte/icons/square-check';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarFooterProps {
		dockPlacement?: 'top' | 'bottom';
		isLoading: boolean;
		searchFilter: string;
		isReorderMode: boolean;
		visibleUnreadCount?: number;
		isMarkingAllRead?: boolean;
		quickMenuSearches?: SavedChatSearch[];
		onOpenSearchDialog: () => void;
		onClearSearchFilter: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onApplyQuickSearch?: (query: string) => void;
		primaryLabel?: string;
		onShowSettings: () => void;
	}

	let {
		dockPlacement = 'bottom',
		isLoading,
		searchFilter,
		isReorderMode,
		visibleUnreadCount = 0,
		isMarkingAllRead = false,
		quickMenuSearches = [],
		onOpenSearchDialog,
		onClearSearchFilter,
		onCreateChat,
		onMarkAllRead,
		onApplyQuickSearch,
		primaryLabel,
		onShowSettings,
	}: SidebarFooterProps = $props();

	let buttonLabel = $derived(primaryLabel ?? m.sidebar_chats_new_chat());
	let showMarkAllRead = $derived(visibleUnreadCount > 0 && !isReorderMode);
	let isMarkAllReadDisabled = $derived(isLoading || isMarkingAllRead);
	const footerControlHeightClass = 'h-9';
	let isTopDock = $derived(dockPlacement === 'top');

	function handleMarkAllRead() {
		onMarkAllRead?.();
	}
</script>

<!-- Mobile footer -->
<div class="md:hidden">
	<div class={`${isTopDock ? 'border-b' : 'border-t'} border-border/60 px-3 pt-2.5 pb-4 space-y-2.5 bg-card`}>
		{#if isTopDock}
			<button
				type="button"
				onclick={onCreateChat}
				class={`w-full ${footerControlHeightClass} px-3 rounded-lg text-sm font-medium border transition-all duration-200 bg-muted/50 text-foreground border-sidebar-border/70 hover:bg-background hover:text-foreground flex items-center justify-center gap-2`}
			>
				{buttonLabel}
			</button>
		{/if}

		{#if !isReorderMode}
			<div class="flex items-center gap-1.5">
				<div class="flex-1">
					<SidebarSearchTrigger
						query={searchFilter}
						onOpen={onOpenSearchDialog}
						onClear={onClearSearchFilter}
					/>
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger
						class={`${footerControlHeightClass} inline-flex w-9 flex-shrink-0 items-center justify-center rounded-md border border-sidebar-border/70 bg-muted/50 px-0 text-muted-foreground transition-colors duration-200 hover:bg-background hover:text-foreground`}
						aria-label={m.sidebar_actions_more()}
						title={m.sidebar_actions_more()}
					>
						<EllipsisVertical class="w-3.5 h-3.5" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{#if quickMenuSearches.length > 0}
							{#each quickMenuSearches as search (search.id)}
								<DropdownMenuItem onclick={() => onApplyQuickSearch?.(search.query)}>
									{search.title}
								</DropdownMenuItem>
							{/each}
							<DropdownMenuSeparator />
						{/if}
						<DropdownMenuItem onclick={handleMarkAllRead} disabled={!showMarkAllRead || isMarkAllReadDisabled}>
							<SquareCheck class="w-3.5 h-3.5" />
							{m.sidebar_chats_mark_all_read()}
						</DropdownMenuItem>
						<DropdownMenuItem onclick={onShowSettings}>
							<Settings class="w-3.5 h-3.5" />
							{m.sidebar_actions_settings()}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		{/if}

		{#if !isTopDock}
			<button
				type="button"
				onclick={onCreateChat}
				class={`w-full ${footerControlHeightClass} px-3 rounded-lg text-sm font-medium border transition-all duration-200 bg-muted/50 text-foreground border-sidebar-border/70 hover:bg-background hover:text-foreground flex items-center justify-center gap-2`}
			>
				{buttonLabel}
			</button>
		{/if}
	</div>
</div>

<!-- Desktop footer -->
<div class={`hidden md:block ${isTopDock ? 'border-b' : 'border-t'} border-border flex-shrink-0`}>
	{#if isTopDock}
		<div class="px-3 pt-2 pb-1">
			<button
				type="button"
				onclick={onCreateChat}
				class={`w-full ${footerControlHeightClass} px-3 rounded-lg text-sm font-medium border transition-all duration-200 bg-muted/50 text-foreground border-sidebar-border/70 hover:bg-background hover:text-foreground flex items-center justify-center gap-2`}
			>
				{buttonLabel}
			</button>
		</div>
	{/if}

	{#if !isReorderMode}
		<div class={`px-3 ${isTopDock ? 'pt-1 pb-2' : 'pt-2 pb-1'}`}>
			<div class="flex items-center gap-1.5">
				<div class="flex-1">
					<SidebarSearchTrigger
						query={searchFilter}
						onOpen={onOpenSearchDialog}
						onClear={onClearSearchFilter}
					/>
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger
						class={`${footerControlHeightClass} inline-flex w-9 flex-shrink-0 items-center justify-center rounded-md border border-sidebar-border/70 bg-muted/50 px-0 text-muted-foreground transition-colors duration-200 hover:bg-background hover:text-foreground`}
						aria-label={m.sidebar_actions_more()}
						title={m.sidebar_actions_more()}
					>
						<EllipsisVertical class="w-3.5 h-3.5" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{#if quickMenuSearches.length > 0}
							{#each quickMenuSearches as search (search.id)}
								<DropdownMenuItem onclick={() => onApplyQuickSearch?.(search.query)}>
									{search.title}
								</DropdownMenuItem>
							{/each}
							<DropdownMenuSeparator />
						{/if}
						<DropdownMenuItem onclick={handleMarkAllRead} disabled={!showMarkAllRead || isMarkAllReadDisabled}>
							<SquareCheck class="w-3.5 h-3.5" />
							{m.sidebar_chats_mark_all_read()}
						</DropdownMenuItem>
						<DropdownMenuItem onclick={onShowSettings}>
							<Settings class="w-3.5 h-3.5" />
							{m.sidebar_actions_settings()}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	{/if}

	{#if !isTopDock}
		<div class="px-3 pt-1 pb-2">
			<button
				type="button"
				onclick={onCreateChat}
				class={`w-full ${footerControlHeightClass} px-3 rounded-lg text-sm font-medium border transition-all duration-200 bg-muted/50 text-foreground border-sidebar-border/70 hover:bg-background hover:text-foreground flex items-center justify-center gap-2`}
			>
				{buttonLabel}
			</button>
		</div>
	{/if}
</div>
