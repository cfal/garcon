<script lang="ts">
	// Modal for selecting or creating a git worktree from the New Chat form.
	// Provides a branch-name-driven create flow with smart path defaults.

	import { tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import X from '@lucide/svelte/icons/x';
	import Check from '@lucide/svelte/icons/check';
	import Plus from '@lucide/svelte/icons/plus';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import type { GitWorktreeItem } from '$lib/api/git.js';
	import { deriveWorktreePath } from '$lib/utils/worktree-path.js';

	interface Props {
		worktrees: GitWorktreeItem[];
		isLoading: boolean;
		isCreating: boolean;
		errorMessage: string | null;
		onSelect: (worktreePath: string) => void;
		onCreate: (worktreePath: string, branch?: string, baseRef?: string) => void;
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
		onClose
	}: Props = $props();

	let showCreateForm = $state(false);
	let branchName = $state('');
	let showAdvanced = $state(false);
	let pathOverride = $state('');
	let baseRefOverride = $state('');
	let branchInputRef: HTMLInputElement | undefined = $state();
	let selectedIndex = $state(-1);

	let derivedPath = $derived(deriveWorktreePath(branchName));
	let effectivePath = $derived(pathOverride.trim() || derivedPath);
	let canCreate = $derived(Boolean(branchName.trim() && effectivePath));
	let selectableWorktrees = $derived(worktrees.filter((wt) => !wt.isPathMissing));

	// Clamp selectedIndex when the list changes (e.g. after refresh),
	// ensuring it never lands on a missing-path worktree.
	$effect.pre(() => {
		if (selectedIndex >= worktrees.length) {
			selectedIndex = worktrees.length - 1;
		}
		while (selectedIndex >= 0 && worktrees[selectedIndex]?.isPathMissing) {
			selectedIndex--;
		}
	});

	// Scroll the selected item into view, matching CommandMenu pattern.
	$effect(() => {
		if (selectedIndex < 0) return;
		const el = document.querySelector(`[data-wt-index="${selectedIndex}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape' && showCreateForm) {
			e.preventDefault();
			e.stopPropagation();
			resetCreateForm();
			return;
		}

		if (showCreateForm) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			let next = selectedIndex + 1;
			while (next < worktrees.length && worktrees[next].isPathMissing) next++;
			if (next < worktrees.length) selectedIndex = next;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			let prev = selectedIndex - 1;
			while (prev >= 0 && worktrees[prev].isPathMissing) prev--;
			if (prev >= 0) selectedIndex = prev;
		} else if (e.key === 'Enter' && selectedIndex >= 0) {
			e.preventDefault();
			const wt = worktrees[selectedIndex];
			if (wt && !wt.isPathMissing) onSelect(wt.path);
		}
	}

	function handleCreate(): void {
		if (!canCreate) return;
		onCreate(
			effectivePath,
			branchName.trim() || undefined,
			baseRefOverride.trim() || undefined
		);
	}

	function resetCreateForm(): void {
		showCreateForm = false;
		branchName = '';
		showAdvanced = false;
		pathOverride = '';
		baseRefOverride = '';
	}

	async function openCreateForm(): Promise<void> {
		showCreateForm = true;
		await tick();
		branchInputRef?.focus();
	}
</script>

<Dialog.Root open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
	<Dialog.Content
		showCloseButton={false}
		aria-label="Select worktree"
		onkeydown={handleKeydown}
		class="w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-xl border border-border bg-popover p-0 shadow-2xl max-h-[80dvh]"
	>
		<div class="flex max-h-[80dvh] flex-col">
			<div class="flex items-center gap-3 border-b border-border px-4 py-3 shrink-0">
				<FolderGit2 class="h-4 w-4 shrink-0 text-muted-foreground" />
				<h2 class="flex-1 text-sm font-medium text-foreground">Select worktree</h2>
				<div class="flex items-center gap-1">
					<button
						type="button"
						onclick={onRefresh}
						disabled={isLoading}
						class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
						title="Refresh worktrees"
						aria-label="Refresh worktrees"
					>
						<RefreshCw class="h-3.5 w-3.5 {isLoading ? 'animate-spin' : ''}" />
					</button>
					<button
						type="button"
						onclick={onClose}
						class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						aria-label="Close"
					>
						<X class="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			{#if errorMessage}
				<div class="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-2.5 text-xs">
					<AlertTriangle class="h-3.5 w-3.5 shrink-0 text-destructive" />
					<span class="flex-1 text-destructive">{errorMessage}</span>
					<button
						type="button"
						onclick={onRefresh}
						class="rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-accent"
					>
						Retry
					</button>
				</div>
			{/if}

			<div class="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox">
				{#if isLoading}
					<div class="flex items-center justify-center py-10">
						<LoaderCircle class="h-5 w-5 animate-spin text-muted-foreground" />
					</div>
				{:else if worktrees.length === 0 && !errorMessage}
					<div class="flex flex-col items-center justify-center gap-2 py-10">
						<GitBranch class="h-5 w-5 text-muted-foreground/50" />
						<span class="text-sm text-muted-foreground">No worktrees found</span>
					</div>
				{:else}
					{#each worktrees as wt, i (wt.path)}
						<button
							type="button"
							data-wt-index={i}
							role="option"
							aria-selected={i === selectedIndex}
							onclick={() => {
								if (!wt.isPathMissing) onSelect(wt.path);
							}}
							onmouseenter={() => { if (!wt.isPathMissing) selectedIndex = i; }}
							disabled={wt.isPathMissing}
							class="w-full rounded-lg px-3 py-2.5 text-left transition-colors
								{i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}
								{wt.isPathMissing ? 'cursor-not-allowed opacity-40' : ''}
								{wt.isCurrent ? 'ring-1 ring-interactive-accent/30' : ''}"
						>
							<div class="flex items-center gap-3">
								<div class="flex h-5 w-5 shrink-0 items-center justify-center">
									{#if wt.isCurrent}
										<Check class="h-4 w-4 text-interactive-accent" />
									{:else}
										<GitBranch class="h-3.5 w-3.5 text-muted-foreground" />
									{/if}
								</div>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="truncate text-sm font-medium">{wt.branch || wt.name}</span>
										{#if wt.isMain}
											<span class="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">main</span>
										{/if}
										{#if wt.isPathMissing}
											<span class="rounded-md bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-destructive">missing</span>
										{/if}
									</div>
									<div class="mt-0.5 truncate font-mono text-xs text-muted-foreground">{wt.path}</div>
								</div>
							</div>
						</button>
					{/each}
				{/if}
			</div>

			{#if showCreateForm}
				<div class="shrink-0 space-y-3 border-t border-border bg-muted/30 px-4 py-3">
					<div class="flex items-center gap-2">
						<Plus class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<span class="text-xs font-medium text-muted-foreground">New worktree</span>
					</div>

					<input
						bind:this={branchInputRef}
						type="text"
						bind:value={branchName}
						placeholder="Branch name (e.g. fix/login-bug)"
						class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground transition-shadow placeholder-muted-foreground/50 focus-visible:border-interactive-accent focus-visible:ring-2 focus-visible:ring-interactive-accent/50"
						onkeydown={(e) => { if (e.key === 'Enter') handleCreate(); }}
					/>

					{#if derivedPath}
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<span class="truncate font-mono text-[11px]">{effectivePath}</span>
							<button
								type="button"
								onclick={() => { showAdvanced = !showAdvanced; }}
								class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								<span class="flex items-center gap-0.5">
									{#if showAdvanced}
										<ChevronDown class="h-3 w-3" />
									{:else}
										<ChevronRight class="h-3 w-3" />
									{/if}
									Advanced
								</span>
							</button>
						</div>
					{/if}

					{#if showAdvanced}
						<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
							<input
								type="text"
								bind:value={pathOverride}
								placeholder="Path override"
								class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground transition-shadow placeholder-muted-foreground/50 focus-visible:border-interactive-accent focus-visible:ring-2 focus-visible:ring-interactive-accent/50"
							/>
							<input
								type="text"
								bind:value={baseRefOverride}
								placeholder="Base ref (HEAD)"
								class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground transition-shadow placeholder-muted-foreground/50 focus-visible:border-interactive-accent focus-visible:ring-2 focus-visible:ring-interactive-accent/50"
							/>
						</div>
					{/if}

					<div class="flex justify-end gap-2 pt-1">
						<button
							type="button"
							onclick={resetCreateForm}
							class="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
						>
							Cancel
						</button>
						<button
							type="button"
							onclick={handleCreate}
							disabled={!canCreate || isCreating}
							class="rounded-lg px-4 py-1.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50
								{canCreate && !isCreating
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

			<div class="flex items-center justify-between border-t border-border bg-popover px-4 py-2.5 shrink-0">
				{#if !showCreateForm}
					<button
						type="button"
						onclick={openCreateForm}
						class="flex items-center gap-1.5 rounded-lg bg-interactive-accent px-3 py-1.5 text-xs font-medium text-interactive-accent-foreground shadow-sm transition-all hover:brightness-110"
					>
						<Plus class="h-3.5 w-3.5" />
						New worktree
					</button>
				{:else}
					<div></div>
				{/if}
				<div class="flex items-center gap-2 text-[10px] text-muted-foreground">
					{#if selectableWorktrees.length > 0}
						<span>{selectableWorktrees.length} worktree{selectableWorktrees.length === 1 ? '' : 's'}</span>
						<span class="text-border">|</span>
					{/if}
					<kbd class="hidden items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono leading-none sm:inline-flex">ESC</kbd>
				</div>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
