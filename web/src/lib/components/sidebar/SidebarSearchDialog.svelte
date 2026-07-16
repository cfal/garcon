<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils/cn.js';
	import SavedSearchPills from './SavedSearchPills.svelte';
	import SidebarSearchResults from './SidebarSearchResults.svelte';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Search from '@lucide/svelte/icons/search';
	import Save from '@lucide/svelte/icons/save';
	import Settings from '@lucide/svelte/icons/settings';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarSearchDialogProps {
		open: boolean;
		query: string;
		filteredChats: ChatSessionRecord[];
		savedSearches: SavedChatSearch[];
		currentTime: Date;
		highlightedIndex: number;
		onQueryChange: (query: string) => void;
		onSelectChat: (chatId: string) => void;
		onApplySavedSearch: (search: SavedChatSearch) => void;
		onCreateSavedSearch: () => void;
		onOpenManager: () => void;
		onHighlightChange: (index: number) => void;
		onClose: () => void;
		showSavedSearchActions?: boolean;
		overlayClass?: string;
		backdropTreatment?: 'standard' | 'interaction-only';
		contentRole?: 'dialog' | 'presentation';
	}

	let {
		open,
		query,
		filteredChats,
		savedSearches,
		currentTime,
		highlightedIndex,
		onQueryChange,
		onSelectChat,
		onApplySavedSearch,
		onCreateSavedSearch,
		onOpenManager,
		onHighlightChange,
		onClose,
		showSavedSearchActions = true,
		overlayClass,
		backdropTreatment = 'standard',
		contentRole = 'dialog',
	}: SidebarSearchDialogProps = $props();

	let inputRef = $state<HTMLInputElement | null>(null);
	let helpDialogOpen = $state(false);
	let trimmedQuery = $derived(query.trim());
	let canCreateSavedSearch = $derived(trimmedQuery.length > 0);

	function handleQueryInput(e: Event) {
		const target = e.target as HTMLInputElement;
		onQueryChange(target.value);
	}

	function handleDialogKeydown(e: KeyboardEvent) {
		const key = e.key.toLowerCase();

		if ((e.ctrlKey || e.metaKey) && key === 's') {
			e.preventDefault();
			e.stopPropagation();
			onClose();
			return;
		}

		if (e.ctrlKey && key === 'j') {
			e.preventDefault();
			onHighlightChange(Math.min(highlightedIndex + 1, filteredChats.length - 1));
			return;
		}

		if (e.ctrlKey && key === 'k') {
			e.preventDefault();
			onHighlightChange(Math.max(highlightedIndex - 1, 0));
			return;
		}

		if (key === 'enter') {
			if (e.target !== inputRef) return;
			e.preventDefault();
			const selected = filteredChats[highlightedIndex];
			if (selected) onSelectChat(selected.id);
			return;
		}

		if (key === 'escape') {
			e.preventDefault();
			e.stopPropagation();
			onClose();
		}
	}

	function focusInput() {
		requestAnimationFrame(() => inputRef?.focus());
	}

	function clearQuery() {
		onQueryChange('');
		focusInput();
	}

	function handleBackdropClick() {
		onClose();
	}

	function handleContainerClick(event: MouseEvent) {
		if (event.target !== event.currentTarget) return;
		onClose();
	}

	$effect(() => {
		if (!open) return;
		focusInput();
	});
</script>

{#if open}
	<div
		class={cn(
			'fixed inset-0 z-50',
			backdropTreatment === 'standard' && 'transient-backdrop',
			overlayClass,
		)}
		role="presentation"
	>
		<button
			class="absolute inset-0 h-full w-full cursor-default"
			onclick={handleBackdropClick}
			aria-label={m.editor_actions_close()}
			tabindex="-1"
		></button>

		<div
			class="fixed inset-0 flex items-stretch justify-center sm:items-start sm:p-4 sm:pt-[10vh]"
			role="presentation"
			onclick={handleContainerClick}
		>
			<div
				data-slot="search-dialog-content"
				class="flex h-dvh w-screen min-w-0 flex-col overflow-hidden bg-background shadow-2xl sm:h-[min(44rem,calc(100dvh-8rem))] sm:w-full sm:max-w-3xl sm:rounded-2xl sm:border sm:border-border"
				role={contentRole}
				aria-label={contentRole === 'dialog' ? m.sidebar_projects_search_placeholder() : undefined}
				aria-modal={contentRole === 'dialog' ? 'true' : undefined}
				tabindex="-1"
				onkeydown={handleDialogKeydown}
			>
				<div class="shrink-0 border-b border-border">
					<div class="flex min-w-0 items-center gap-2 px-4 py-3">
						<div
							data-slot="search-dialog-input-shell"
							class="relative h-9 min-w-0 flex-1 rounded-lg border border-sidebar-border/70 bg-muted/50 text-sm text-foreground transition-colors focus-within:border-border focus-within:bg-background"
						>
							<Search
								class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
							/>
							<input
								bind:this={inputRef}
								type="text"
								value={query}
								oninput={handleQueryInput}
								placeholder={m.sidebar_projects_search_placeholder()}
								class="h-full w-full rounded-[inherit] bg-transparent pl-9 pr-8 text-[16px] leading-6 text-foreground placeholder:text-muted-foreground outline-none sm:text-sm sm:leading-5"
							/>
							{#if query.length > 0}
								<button
									type="button"
									class="absolute right-2 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
									onclick={clearQuery}
									aria-label={m.filetree_clear_search()}
									title={m.filetree_clear_search()}
								>
									<X class="h-3 w-3" />
								</button>
							{/if}
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							class="h-9 w-9 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground"
							onclick={() => (helpDialogOpen = true)}
							title={m.sidebar_search_legend_help()}
							aria-label={m.sidebar_search_legend_help()}
						>
							<CircleHelp class="h-4 w-4" />
						</Button>

						{#if showSavedSearchActions}
							<Button
								variant="ghost"
								size="icon-sm"
								class="h-9 w-9 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground"
								onclick={onCreateSavedSearch}
								title={m.sidebar_saved_searches_add()}
								aria-label={m.sidebar_saved_searches_add()}
								disabled={!canCreateSavedSearch}
							>
								<Save class="h-4 w-4" />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								class="h-9 w-9 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground"
								onclick={onOpenManager}
								title={m.sidebar_saved_searches_manage_menu_item()}
								aria-label={m.sidebar_saved_searches_manage_menu_item()}
							>
								<Settings class="h-4 w-4" />
							</Button>
						{/if}
						<Button
							variant="ghost"
							size="icon-sm"
							class="h-9 w-9 shrink-0 rounded-md border border-sidebar-border/70 bg-muted/50 text-muted-foreground hover:bg-background hover:text-foreground sm:hidden"
							onclick={onClose}
							title={m.sidebar_search_close()}
							aria-label={m.sidebar_search_close()}
						>
							<X class="h-4 w-4" />
						</Button>
					</div>

					{#if showSavedSearchActions && savedSearches.length > 0}
						<div class="px-4 pb-4" data-slot="saved-search-pills">
							<SavedSearchPills searches={savedSearches} onApply={onApplySavedSearch} />
						</div>
					{/if}
				</div>

				<SidebarSearchResults
					{filteredChats}
					{currentTime}
					{highlightedIndex}
					{onSelectChat}
					{onHighlightChange}
				/>
			</div>
		</div>
	</div>
	<Dialog.Root open={helpDialogOpen} onOpenChange={(v) => (helpDialogOpen = v)}>
		<Dialog.Content
			class="h-dvh w-full max-w-full rounded-none border-0 p-6 sm:h-auto sm:rounded-lg sm:border"
		>
			<Dialog.Header>
				<Dialog.Title>{m.sidebar_search_legend_help()}</Dialog.Title>
				<p class="text-sm text-muted-foreground">
					{m.sidebar_search_legend_description()}
				</p>
			</Dialog.Header>
			<div class="space-y-2 text-sm">
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>Any text</code
					>
					<span class="text-muted-foreground"
						>{m.sidebar_search_legend_free_text_description()}</span
					>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground">tag:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_tag()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>agent:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_agent()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>model:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_model()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>status:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_status()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>project:X</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_project()}</span>
				</div>
				<div class="flex gap-3">
					<code class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-muted-foreground"
						>tag:X project:Y</code
					>
					<span class="text-muted-foreground">{m.sidebar_search_legend_combine()}</span>
				</div>
			</div>
			<Dialog.Footer>
				<Button onclick={() => (helpDialogOpen = false)}>{m.editor_actions_close()}</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
