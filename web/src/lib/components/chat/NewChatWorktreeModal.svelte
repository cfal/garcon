<script lang="ts">
	// Modal for selecting or creating a git worktree from the New Chat form.
	// Provides a branch-name-driven create flow with smart path defaults.

	import { tick } from 'svelte';
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

	// Scroll the selected item into view, matching CommandMenu pattern
	$effect(() => {
		if (selectedIndex < 0) return;
		const el = document.querySelector(`[data-wt-index="${selectedIndex}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			if (showCreateForm) {
				resetCreateForm();
			} else {
				onClose();
			}
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

<svelte:window onkeydown={handleKeydown} />

<!-- Backdrop -->
<div class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" role="presentation">
	<button
		class="absolute inset-0 w-full h-full cursor-default"
		onclick={onClose}
		aria-label="Close worktree selector"
		tabindex="-1"
	></button>

	<!-- Dialog -->
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Select worktree"
		tabindex="-1"
		class="fixed top-[20%] left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-lg bg-popover border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[60dvh]"
	>
		<!-- Header -->
		<div class="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
			<FolderGit2 class="w-4 h-4 text-muted-foreground shrink-0" />
			<h2 class="text-sm font-medium text-foreground flex-1">Select worktree</h2>
			<div class="flex items-center gap-1">
				<button
					onclick={onRefresh}
					disabled={isLoading}
					class="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
					title="Refresh worktrees"
					aria-label="Refresh worktrees"
				>
					<RefreshCw class="w-3.5 h-3.5 {isLoading ? 'animate-spin' : ''}" />
				</button>
				<button
					onclick={onClose}
					class="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
					aria-label="Close"
				>
					<X class="w-3.5 h-3.5" />
				</button>
			</div>
		</div>

		<!-- Error banner -->
		{#if errorMessage}
			<div class="flex items-center gap-2 px-4 py-2.5 text-xs bg-destructive/10 border-b border-border">
				<AlertTriangle class="w-3.5 h-3.5 shrink-0 text-destructive" />
				<span class="flex-1 text-destructive">{errorMessage}</span>
				<button
					onclick={onRefresh}
					class="px-2 py-1 text-[10px] font-medium rounded-md bg-muted hover:bg-accent transition-colors text-foreground"
				>
					Retry
				</button>
			</div>
		{/if}

		<!-- Body (scrollable worktree list) -->
		<div class="flex-1 overflow-y-auto min-h-0 p-1.5" role="listbox">
			{#if isLoading}
				<div class="flex items-center justify-center py-10">
					<LoaderCircle class="w-5 h-5 animate-spin text-muted-foreground" />
				</div>
			{:else if worktrees.length === 0 && !errorMessage}
				<div class="flex flex-col items-center justify-center py-10 gap-2">
					<GitBranch class="w-5 h-5 text-muted-foreground/50" />
					<span class="text-sm text-muted-foreground">No worktrees found</span>
				</div>
			{:else}
				{#each worktrees as wt, i (wt.path)}
					<button
						data-wt-index={i}
						role="option"
						aria-selected={i === selectedIndex}
						onclick={() => {
							if (!wt.isPathMissing) onSelect(wt.path);
						}}
						onmouseenter={() => { if (!wt.isPathMissing) selectedIndex = i; }}
						disabled={wt.isPathMissing}
						class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors
							{i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}
							{wt.isPathMissing ? 'opacity-40 cursor-not-allowed' : ''}
							{wt.isCurrent ? 'ring-1 ring-interactive-accent/30' : ''}"
					>
						<div class="flex items-center justify-center w-5 h-5 shrink-0">
							{#if wt.isCurrent}
								<Check class="w-4 h-4 text-interactive-accent" />
							{:else}
								<GitBranch class="w-3.5 h-3.5 text-muted-foreground" />
							{/if}
						</div>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium truncate">{wt.branch || wt.name}</span>
								{#if wt.isMain}
									<span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground leading-none">main</span>
								{/if}
								{#if wt.isPathMissing}
									<span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-destructive/15 text-destructive leading-none">missing</span>
								{/if}
							</div>
							<div class="text-xs text-muted-foreground truncate mt-0.5 font-mono">{wt.path}</div>
						</div>
					</button>
				{/each}
			{/if}
		</div>

		<!-- Create form (pinned below scroll area) -->
		{#if showCreateForm}
			<div class="border-t border-border px-4 py-3 space-y-3 shrink-0 bg-muted/30">
				<div class="flex items-center gap-2">
					<Plus class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
					<span class="text-xs font-medium text-muted-foreground">New worktree</span>
				</div>

				<input
					bind:this={branchInputRef}
					type="text"
					bind:value={branchName}
					placeholder="Branch name (e.g. fix/login-bug)"
					class="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg
						focus-visible:ring-2 focus-visible:ring-interactive-accent/50 focus-visible:border-interactive-accent
						text-foreground placeholder-muted-foreground/50 transition-shadow"
					onkeydown={(e) => { if (e.key === 'Enter') handleCreate(); }}
				/>

				{#if derivedPath}
					<div class="flex items-center gap-2 text-xs text-muted-foreground">
						<span class="truncate font-mono text-[11px]">{effectivePath}</span>
						<button
							onclick={() => { showAdvanced = !showAdvanced; }}
							class="flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0 px-1.5 py-0.5 rounded-md hover:bg-muted"
						>
							{#if showAdvanced}
								<ChevronDown class="w-3 h-3" />
							{:else}
								<ChevronRight class="w-3 h-3" />
							{/if}
							Advanced
						</button>
					</div>
				{/if}

				{#if showAdvanced}
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<input
							type="text"
							bind:value={pathOverride}
							placeholder="Path override"
							class="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg
								focus-visible:ring-2 focus-visible:ring-interactive-accent/50 focus-visible:border-interactive-accent
								text-foreground placeholder-muted-foreground/50 transition-shadow"
						/>
						<input
							type="text"
							bind:value={baseRefOverride}
							placeholder="Base ref (HEAD)"
							class="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg
								focus-visible:ring-2 focus-visible:ring-interactive-accent/50 focus-visible:border-interactive-accent
								text-foreground placeholder-muted-foreground/50 transition-shadow"
						/>
					</div>
				{/if}

				<div class="flex gap-2 justify-end pt-1">
					<button
						onclick={resetCreateForm}
						class="px-3 py-1.5 text-xs font-medium rounded-lg bg-muted text-muted-foreground hover:text-foreground transition-colors"
					>
						Cancel
					</button>
					<button
						onclick={handleCreate}
						disabled={!canCreate || isCreating}
						class="px-4 py-1.5 text-xs font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed
							{canCreate && !isCreating
								? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110 shadow-sm'
								: 'bg-muted text-muted-foreground'}"
					>
						{#if isCreating}
							<span class="flex items-center gap-1.5">
								<LoaderCircle class="w-3 h-3 animate-spin" />
								Creating...
							</span>
						{:else}
							Create
						{/if}
					</button>
				</div>
			</div>
		{/if}

		<!-- Footer -->
		<div class="flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0 bg-popover">
			{#if !showCreateForm}
				<button
					onclick={openCreateForm}
					class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
						bg-interactive-accent text-interactive-accent-foreground hover:brightness-110 shadow-sm transition-all"
				>
					<Plus class="w-3.5 h-3.5" />
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
				<kbd class="hidden sm:inline-flex items-center px-1.5 py-0.5 font-mono bg-muted rounded border border-border leading-none">ESC</kbd>
			</div>
		</div>
	</div>
</div>
