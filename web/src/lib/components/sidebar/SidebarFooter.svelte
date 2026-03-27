<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import Settings from '@lucide/svelte/icons/settings';

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
				{#if showMarkAllRead}
					<div class="flex justify-end">
						<Button
							variant="ghost"
							size="sm"
							class="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
							onclick={handleMarkAllRead}
							disabled={isMarkAllReadDisabled}
						>
							{m.sidebar_chats_mark_all_read()}
						</Button>
					</div>
				{/if}
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
					<Button
						variant="ghost"
						size="sm"
						class={`${footerControlHeightClass} w-9 px-0 border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-background transition-colors duration-200 rounded-md flex-shrink-0`}
						onclick={onShowSettings}
						title={m.sidebar_actions_settings()}
					>
						<Settings class="w-3.5 h-3.5" />
					</Button>
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
				{#if showMarkAllRead}
					<div class="flex justify-end pb-1">
						<Button
							variant="ghost"
							size="sm"
							class="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
							onclick={handleMarkAllRead}
							disabled={isMarkAllReadDisabled}
						>
							{m.sidebar_chats_mark_all_read()}
						</Button>
					</div>
				{/if}
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
					<Button
						variant="ghost"
						size="sm"
						class={`${footerControlHeightClass} w-9 px-0 border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-background transition-colors duration-200 rounded-md flex-shrink-0`}
						onclick={onShowSettings}
						title={m.sidebar_actions_settings()}
					>
						<Settings class="w-3.5 h-3.5" />
					</Button>
				</div>
			</div>
		{/if}
	</div>
