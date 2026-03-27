<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { Button } from '$lib/components/ui/button';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import Input from '$lib/components/ui/input/input.svelte';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import Settings from '@lucide/svelte/icons/settings';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import SquareCheck from '@lucide/svelte/icons/square-check';

	interface SidebarFooterProps {
		isLoading: boolean;
		searchFilter: string;
		isReorderMode: boolean;
		visibleUnreadCount?: number;
		isMarkingAllRead?: boolean;
		onSearchFilterChange: (value: string) => void;
		onClearSearchFilter: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		primaryLabel?: string;
		onShowSettings: () => void;
	}

	let {
		isLoading,
		searchFilter,
		isReorderMode,
		visibleUnreadCount = 0,
		isMarkingAllRead = false,
		onSearchFilterChange,
		onClearSearchFilter,
		onCreateChat,
		onMarkAllRead,
		primaryLabel,
		onShowSettings,
	}: SidebarFooterProps = $props();

	let buttonLabel = $derived(primaryLabel ?? m.sidebar_chats_new_chat());
	let showMarkAllRead = $derived(visibleUnreadCount > 0 && !isReorderMode);
	let isMarkAllReadDisabled = $derived(isLoading || isMarkingAllRead);
	const footerControlHeightClass = 'h-9';

	function handleSearchInput(e: Event) {
		const target = e.target as HTMLInputElement;
		onSearchFilterChange(target.value);
	}

	function handleMarkAllRead() {
		onMarkAllRead?.();
	}
</script>

<!-- Mobile footer -->
<div class="md:hidden">
	<div class="border-t border-border/60 px-3 pt-2.5 pb-4 space-y-2.5 bg-card">
			<button
				type="button"
				onclick={onCreateChat}
				class={`w-full ${footerControlHeightClass} px-3 rounded-lg text-sm font-medium border transition-all duration-200 bg-muted/50 text-foreground border-sidebar-border/70 hover:bg-background hover:text-foreground flex items-center justify-center gap-2`}
			>
			{buttonLabel}
		</button>

			{#if !isReorderMode}
				<div class="flex items-center gap-1.5">
					<div class="relative flex-1">
						<Search class="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
						<Input
							type="text"
							placeholder={m.sidebar_projects_search_placeholder()}
							value={searchFilter}
							oninput={handleSearchInput}
							class={`pl-8 ${footerControlHeightClass} text-sm bg-muted/50 border border-sidebar-border/70 focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-primary/20`}
						/>
						{#if searchFilter}
							<button
								onclick={onClearSearchFilter}
								class="absolute right-2 top-1/2 transform -translate-y-1/2 p-1 hover:bg-accent rounded"
							>
								<X class="w-3 h-3 text-muted-foreground" />
							</button>
						{/if}
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
		</div>
	</div>

<!-- Desktop footer -->
<div class="hidden md:block border-t border-border flex-shrink-0">
		<div class="px-3 pt-2 pb-1">
			<button
				type="button"
				onclick={onCreateChat}
				class={`w-full ${footerControlHeightClass} px-3 rounded-lg text-sm font-medium border transition-all duration-200 bg-muted/50 text-foreground border-sidebar-border/70 hover:bg-background hover:text-foreground flex items-center justify-center gap-2`}
			>
			{buttonLabel}
		</button>
	</div>

		{#if !isReorderMode}
			<div class="px-3 pt-1 pb-2">
				<div class="flex items-center gap-1.5">
					<div class="relative flex-1">
						<Search class="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
						<Input
							type="text"
							placeholder={m.sidebar_projects_search_placeholder()}
							value={searchFilter}
							oninput={handleSearchInput}
							class={`pl-8 ${footerControlHeightClass} text-xs bg-muted/50 border border-sidebar-border/70 focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-primary/20 disabled:opacity-100`}
							disabled={isLoading}
						/>
						{#if searchFilter}
							<button
								onclick={onClearSearchFilter}
								class="absolute right-2 top-1/2 transform -translate-y-1/2 p-1 hover:bg-accent rounded"
							>
								<X class="w-3 h-3 text-muted-foreground" />
							</button>
						{/if}
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
	</div>
