<script lang="ts">
	import { tick } from 'svelte';
	import GitWorktreeCreateForm from './GitWorktreeCreateForm.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import TreePine from '@lucide/svelte/icons/tree-pine';
	import Search from '@lucide/svelte/icons/search';
	import ListFilter from '@lucide/svelte/icons/list-filter';
	import ArrowDownAZ from '@lucide/svelte/icons/arrow-down-a-z';
	import ArrowDownZA from '@lucide/svelte/icons/arrow-down-z-a';
	import Clock from '@lucide/svelte/icons/clock';
	import type { GitWorktreeItem, GitWorktreeCreation } from '$lib/api/git.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import * as m from '$lib/paraglide/messages.js';
	import { getOptionalTransientLayers } from '$lib/context';
	import { transientLayer } from '$lib/workspace/transient-layer-action.js';
	import GitWorktreePickerList from './GitWorktreePickerList.svelte';
	import {
		findRepositoryWorktreePath,
		GitWorktreePickerState,
	} from './git-worktree-picker-state.svelte.js';

	interface Props {
		worktrees: GitWorktreeItem[];
		contextKey?: string;
		description?: string;
		isLoading: boolean;
		isCreating: boolean;
		errorMessage: string | null;
		onSelect: (worktreePath: string) => void;
		onCreate: (creation: GitWorktreeCreation) => void;
		onRefresh: () => void;
		onClose: () => void;
	}

	let {
		worktrees,
		contextKey = '',
		description = '',
		isLoading,
		isCreating,
		errorMessage,
		onSelect,
		onCreate,
		onRefresh,
		onClose,
	}: Props = $props();
	let repositoryWorktreePath = $derived(findRepositoryWorktreePath(worktrees));

	const picker = new GitWorktreePickerState({
		get worktrees() {
			return worktrees;
		},
		get locale() {
			return getLocale();
		},
		get repositoryWorktreePath() {
			return repositoryWorktreePath;
		},
	});
	const componentId = $props.id();
	const listboxId = `${componentId}-worktrees`;
	const transientLayers = getOptionalTransientLayers();
	let filterInputRef: HTMLInputElement | null = $state(null);
	let createTarget = $state('');
	let createOpen = $derived(picker.showCreateForm && createTarget === contextKey);
	$effect(() => {
		if (picker.showCreateForm && createTarget !== contextKey) picker.resetCreateForm();
	});
	let activeOptionId = $state<string | undefined>();

	function handleDialogKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !picker.showCreateForm) return;
		event.preventDefault();
		event.stopPropagation();
		backToList();
	}

	function createFormLayer(node: HTMLElement): ReturnType<typeof transientLayer> | undefined {
		if (!transientLayers) return;
		return transientLayer(node, {
			registry: transientLayers,
			id: `${componentId}-create-form-layer`,
			kind: 'popover',
			modality: 'nonmodal',
			onEscape: () => {
				backToList();
				return true;
			},
			restoreFocus: () => filterInputRef?.focus(),
		});
	}

	function handleFilterKeydown(event: KeyboardEvent): void {
		if (isLoading || picker.showCreateForm || event.isComposing || event.keyCode === 229) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			picker.moveSelection(1);
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			picker.moveSelection(-1);
			return;
		}
		if (event.key !== 'Enter') return;
		event.preventDefault();
		const selected = picker.selectedWorktree;
		if (selected && activeOptionId) onSelect(selected.path);
	}

	function backToList(): void {
		if (isCreating) return;
		picker.resetCreateForm();
		if (errorMessage) onRefresh();
		void tick().then(() => filterInputRef?.focus());
	}

	function selectVisibleWorktree(worktreePath: string): void {
		const worktree = picker.visibleWorktrees.find((item) => item.path === worktreePath);
		if (worktree && !worktree.isPathMissing) onSelect(worktreePath);
	}

	function openCreateForm(): void {
		if (isLoading || isCreating) return;
		createTarget = contextKey;
		picker.showCreateForm = true;
	}
</script>

<Dialog.Root
	open={true}
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
>
	<Dialog.Content
		showCloseButton={false}
		aria-label={createOpen ? m.git_worktree_new() : m.workspace_worktree_select()}
		onkeydown={handleDialogKeydown}
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			queueMicrotask(() => filterInputRef?.focus());
		}}
		class={`top-[var(--app-viewport-center-y)] w-[calc(100vw-1rem)] max-w-lg overflow-hidden rounded-lg border border-border bg-popover p-0 shadow-2xl sm:w-full ${
			!createOpen ? 'h-[min(36rem,calc(var(--app-height)-1rem))]'
				: picker.showAdvanced ? 'h-[min(26rem,calc(var(--app-height)-1rem))]'
				: 'h-[min(22rem,calc(var(--app-height)-1rem))]'
		}`}
	>
		<div class="flex h-full min-h-0 min-w-0 flex-col">
			<div class="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
				<TreePine class="h-4 w-4 shrink-0 text-muted-foreground" />
				<h2 class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
					{createOpen ? m.git_worktree_new() : m.git_worktree_select()}
				</h2>
				<div class="flex items-center gap-1">
					{#if !createOpen}
						<button
							type="button"
							onclick={onRefresh}
							disabled={isLoading || isCreating}
							class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
							title={m.workspace_worktree_refresh()}
							aria-label={m.workspace_worktree_refresh()}
						>
							<RefreshCw class="h-3.5 w-3.5 {isLoading ? 'animate-spin' : ''}" />
						</button>
					{/if}
					<button
						type="button"
						onclick={onClose}
						class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						aria-label={m.share_dialog_close()}
					>
						<X class="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			<div
				hidden={createOpen}
				inert={createOpen}
				class={createOpen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
			>
				{#if errorMessage}
					<div
						class="flex min-w-0 shrink-0 items-center gap-2 border-b border-border bg-destructive/10 px-4 py-2.5 text-xs"
					>
						<AlertTriangle class="h-3.5 w-3.5 shrink-0 text-destructive" />
						<span class="min-w-0 flex-1 break-words text-destructive">{errorMessage}</span>
						<button
							type="button"
							onclick={onRefresh}
							disabled={isLoading || isCreating}
							class="shrink-0 rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-accent"
						>
							{m.common_retry()}
						</button>
					</div>
				{/if}

				<div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
					<div class="relative min-w-0 flex-1">
						<Search
							class="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							bind:ref={filterInputRef}
							bind:value={picker.filterQuery}
							type="search"
							role="combobox"
							aria-label={m.workspace_worktree_filter_label()}
							aria-controls={listboxId}
							aria-expanded="true"
							aria-autocomplete="list"
							aria-activedescendant={activeOptionId}
							placeholder={m.workspace_worktree_filter_placeholder()}
							onkeydown={handleFilterKeydown}
							class="h-8 pl-8 md:text-base"
						/>
					</div>
					<div class="shrink-0">
						<DropdownMenu>
							<DropdownMenuTrigger
								class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:border-interactive-accent focus-visible:ring-2 focus-visible:ring-interactive-accent/50"
								aria-label={m.workspace_worktree_sort_label()}
								title={m.workspace_worktree_sort_label()}
							>
								<ListFilter class="h-3.5 w-3.5" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" class="min-w-64">
								<DropdownMenuRadioGroup
									value={picker.sortOrder}
									onValueChange={(value) => picker.setSortOrder(value)}
								>
									<DropdownMenuRadioItem value="alphabetical-ascending">
										<ArrowDownAZ class="h-3.5 w-3.5" />
										{m.workspace_worktree_sort_alphabetical_ascending()}
									</DropdownMenuRadioItem>
									<DropdownMenuRadioItem value="alphabetical-descending">
										<ArrowDownZA class="h-3.5 w-3.5" />
										{m.workspace_worktree_sort_alphabetical_descending()}
									</DropdownMenuRadioItem>
									<DropdownMenuRadioItem value="last-modified">
										<Clock class="h-3.5 w-3.5" />
										{m.workspace_worktree_sort_last_modified()}
									</DropdownMenuRadioItem>
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>

				<GitWorktreePickerList
					{listboxId}
					worktrees={picker.visibleWorktrees}
					totalWorktreeCount={worktrees.length}
					selectedIndex={picker.selectedIndex}
					selectedPath={picker.selectedWorktree?.path}
					{isLoading}
					hasLoadError={Boolean(errorMessage)}
					onActivate={(worktreePath) => picker.selectPath(worktreePath)}
					onSelect={selectVisibleWorktree}
					onActiveOptionIdChange={(optionId) => {
						activeOptionId = optionId;
					}}
				/>

				<div
					class="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3"
				>
					<button
						type="button"
						onclick={openCreateForm}
						disabled={isLoading || isCreating}
						class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
					>
						<Plus class="size-4" />{m.git_worktree_new()}
					</button>
					<span class="text-xs text-muted-foreground">
						{#if picker.hasActiveFilter}
							{m.workspace_worktree_filtered_count({
								visible: picker.visibleCount,
								total: picker.totalCount,
							})}
						{:else if picker.totalCount > 0}
							{m.git_worktree_count({ count: picker.totalCount })}
						{/if}
					</span>
				</div>
			</div>
			{#if createOpen}
				<div class="flex min-h-0 flex-1 flex-col" use:createFormLayer>
					<GitWorktreeCreateForm
						{picker}
						{contextKey}
						{description}
						{isCreating}
						{errorMessage}
						onBack={backToList}
						onCreate={(creation) => {
							if (createOpen && !isCreating) onCreate(creation);
						}}
					/>
				</div>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
