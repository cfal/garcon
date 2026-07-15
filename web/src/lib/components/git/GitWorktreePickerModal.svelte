<script lang="ts">
	import { tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import TreePine from '@lucide/svelte/icons/tree-pine';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Search from '@lucide/svelte/icons/search';
	import type { GitWorktreeItem } from '$lib/api/git.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import * as m from '$lib/paraglide/messages.js';
	import { getOptionalTransientLayers } from '$lib/context';
	import { transientLayer } from '$lib/workspace/transient-layer-action.js';
	import GitWorktreePickerList from './GitWorktreePickerList.svelte';
	import {
		GitWorktreePickerState,
		type WorktreeSortOrder,
	} from './git-worktree-picker-state.svelte.js';

	interface Props {
		worktrees: GitWorktreeItem[];
		isLoading: boolean;
		isCreating: boolean;
		errorMessage: string | null;
		onSelect: (worktreePath: string) => void;
		onCreate: (worktreePath: string, branch?: string, baseRef?: string) => void | Promise<void>;
		onRefresh: () => void;
		onClose: () => void;
	}

	let {
		worktrees,
		isLoading,
		isCreating,
		errorMessage,
		onSelect,
		onCreate,
		onRefresh,
		onClose,
	}: Props = $props();

	const picker = new GitWorktreePickerState({
		get worktrees() {
			return worktrees;
		},
		get locale() {
			return getLocale();
		},
	});
	const componentId = $props.id();
	const listboxId = `${componentId}-worktrees`;
	const transientLayers = getOptionalTransientLayers();
	let filterInputRef: HTMLInputElement | null = $state(null);
	let branchInputRef: HTMLInputElement | null = $state(null);
	let activeOptionId = $state<string | undefined>();

	function sortLabel(sortOrder: WorktreeSortOrder): string {
		if (sortOrder === 'alphabetical-ascending') {
			return m.workspace_worktree_sort_alphabetical_ascending();
		}
		if (sortOrder === 'alphabetical-descending') {
			return m.workspace_worktree_sort_alphabetical_descending();
		}
		return m.workspace_worktree_sort_last_modified();
	}

	function handleDialogKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !picker.showCreateForm) return;
		event.preventDefault();
		event.stopPropagation();
		picker.resetCreateForm();
		queueMicrotask(() => filterInputRef?.focus());
	}

	function createFormLayer(node: HTMLElement): ReturnType<typeof transientLayer> | undefined {
		if (!transientLayers) return;
		return transientLayer(node, {
			registry: transientLayers,
			id: `${componentId}-create-form-layer`,
			kind: 'popover',
			modality: 'nonmodal',
			onEscape: () => {
				picker.resetCreateForm();
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
		if (selected) onSelect(selected.path);
	}

	function handleCreate(): void {
		if (!picker.canCreate) return;
		void onCreate(
			picker.effectivePath,
			picker.branchName.trim() || undefined,
			picker.baseRefOverride.trim() || undefined,
		);
	}

	function selectVisibleWorktree(worktreePath: string): void {
		const worktree = picker.visibleWorktrees.find((item) => item.path === worktreePath);
		if (worktree && !worktree.isPathMissing) onSelect(worktreePath);
	}

	async function openCreateForm(): Promise<void> {
		picker.showCreateForm = true;
		await tick();
		branchInputRef?.focus();
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
		aria-label={m.workspace_worktree_select()}
		onkeydown={handleDialogKeydown}
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			queueMicrotask(() => filterInputRef?.focus());
		}}
		class="top-[var(--app-viewport-center-y)] h-[min(36rem,calc(var(--app-height)-1rem))] w-[calc(100vw-1rem)] max-w-lg overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-popover p-0 shadow-2xl sm:w-full"
	>
		<div class="flex h-full min-h-0 min-w-0 flex-col">
			<div class="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
				<TreePine class="h-4 w-4 shrink-0 text-muted-foreground" />
				<h2 class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">Select worktree</h2>
				<div class="flex items-center gap-1">
					<button
						type="button"
						onclick={onRefresh}
						disabled={isLoading}
						class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
						title={m.workspace_worktree_refresh()}
						aria-label={m.workspace_worktree_refresh()}
					>
						<RefreshCw class="h-3.5 w-3.5 {isLoading ? 'animate-spin' : ''}" />
					</button>
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

			{#if errorMessage}
				<div
					class="flex min-w-0 items-center gap-2 border-b border-border bg-destructive/10 px-4 py-2.5 text-xs"
				>
					<AlertTriangle class="h-3.5 w-3.5 shrink-0 text-destructive" />
					<span class="min-w-0 flex-1 break-words text-destructive">{errorMessage}</span>
					<button
						type="button"
						onclick={onRefresh}
						class="shrink-0 rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-accent"
					>
						Retry
					</button>
				</div>
			{/if}

			<div
				class="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5 sm:flex-row sm:items-center"
			>
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
						class="h-8 pl-8"
					/>
				</div>
				<div class="min-w-0 w-full self-end sm:w-auto">
					<Select.Root
						type="single"
						value={picker.sortOrder}
						onValueChange={(value) => {
							if (value) picker.setSortOrder(value);
						}}
					>
						<Select.Trigger
							size="sm"
							aria-label={m.workspace_worktree_sort_label()}
							class="min-w-0 w-full sm:w-[15rem]"
						>
							{sortLabel(picker.sortOrder)}
						</Select.Trigger>
						<Select.Content>
							<Select.Item
								value="alphabetical-ascending"
								label={m.workspace_worktree_sort_alphabetical_ascending()}
							/>
							<Select.Item
								value="alphabetical-descending"
								label={m.workspace_worktree_sort_alphabetical_descending()}
							/>
							<Select.Item
								value="last-modified"
								label={m.workspace_worktree_sort_last_modified()}
							/>
						</Select.Content>
					</Select.Root>
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

			{#if picker.showCreateForm}
				<div
					class="shrink-0 space-y-3 border-t border-border bg-muted/30 px-4 py-3"
					use:createFormLayer
				>
					<div class="flex items-center gap-2">
						<Plus class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<span class="text-xs font-medium text-muted-foreground">New worktree</span>
					</div>

					<input
						bind:this={branchInputRef}
						type="text"
						bind:value={picker.branchName}
						placeholder={m.workspace_worktree_branch_name_placeholder()}
						class="w-full rounded-md border border-border bg-background px-3 py-2 text-base text-foreground transition-shadow placeholder-muted-foreground/50 focus-visible:border-interactive-accent focus-visible:ring-2 focus-visible:ring-interactive-accent/50 md:text-sm"
						onkeydown={(event) => {
							if (event.key === 'Enter') handleCreate();
						}}
					/>

					{#if picker.derivedPath}
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<span class="truncate font-mono text-[11px]">{picker.effectivePath}</span>
							<button
								type="button"
								onclick={() => {
									picker.showAdvanced = !picker.showAdvanced;
								}}
								class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								<span class="flex items-center gap-0.5">
									{#if picker.showAdvanced}
										<ChevronDown class="h-3 w-3" />
									{:else}
										<ChevronRight class="h-3 w-3" />
									{/if}
									Advanced
								</span>
							</button>
						</div>
					{/if}

					{#if picker.showAdvanced}
						<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
							<input
								type="text"
								bind:value={picker.pathOverride}
								placeholder={m.workspace_worktree_path_override_placeholder()}
								class="w-full rounded-md border border-border bg-background px-3 py-2 text-base text-foreground transition-shadow placeholder-muted-foreground/50 focus-visible:border-interactive-accent focus-visible:ring-2 focus-visible:ring-interactive-accent/50 md:text-sm"
							/>
							<input
								type="text"
								bind:value={picker.baseRefOverride}
								placeholder={m.workspace_worktree_base_ref_placeholder()}
								class="w-full rounded-md border border-border bg-background px-3 py-2 text-base text-foreground transition-shadow placeholder-muted-foreground/50 focus-visible:border-interactive-accent focus-visible:ring-2 focus-visible:ring-interactive-accent/50 md:text-sm"
							/>
						</div>
					{/if}

					<div class="flex justify-end gap-2 pt-1">
						<button
							type="button"
							onclick={() => picker.resetCreateForm()}
							class="rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
						>
							Cancel
						</button>
						<button
							type="button"
							onclick={handleCreate}
							disabled={!picker.canCreate || isCreating}
							class="rounded-md px-4 py-1.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50
								{picker.canCreate && !isCreating
								? 'bg-interactive-accent text-interactive-accent-foreground shadow-sm hover:brightness-110'
								: 'bg-muted text-muted-foreground'}"
						>
							{#if isCreating}
								<span class="flex items-center gap-1.5">
									<LoaderCircle class="h-3 w-3 animate-spin" />
									Creating...
								</span>
							{:else}
								Create
							{/if}
						</button>
					</div>
				</div>
			{/if}

			<div
				class="flex min-w-0 shrink-0 items-center justify-between gap-2 border-t border-border bg-popover px-4 py-2.5"
			>
				{#if !picker.showCreateForm}
					<button
						type="button"
						onclick={openCreateForm}
						class="flex items-center gap-1.5 rounded-md bg-interactive-accent px-3 py-1.5 text-xs font-medium text-interactive-accent-foreground shadow-sm transition-all hover:brightness-110"
					>
						<Plus class="h-3.5 w-3.5" />
						New worktree
					</button>
				{:else}
					<div></div>
				{/if}
				<div
					class="flex min-w-0 items-center justify-end gap-2 text-right text-[10px] text-muted-foreground"
				>
					{#if picker.hasActiveFilter}
						<span class="truncate">
							{m.workspace_worktree_filtered_count({
								visible: picker.visibleCount,
								total: picker.totalCount,
							})}
						</span>
					{:else if picker.totalCount > 0}
						<span class="truncate">
							{picker.totalCount} worktree{picker.totalCount === 1 ? '' : 's'}
						</span>
					{/if}
					{#if picker.totalCount > 0 || picker.hasActiveFilter}
						<span class="hidden text-border sm:inline">|</span>
					{/if}
					<kbd
						class="hidden items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono leading-none sm:inline-flex"
						>ESC</kbd
					>
				</div>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
