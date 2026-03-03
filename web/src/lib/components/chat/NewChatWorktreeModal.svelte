<script lang="ts">
	// Modal for selecting or creating a git worktree from the New Chat form.

	import X from '@lucide/svelte/icons/x';
	import Check from '@lucide/svelte/icons/check';
	import Plus from '@lucide/svelte/icons/plus';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import type { GitWorktreeItem } from '$lib/api/git.js';

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
	let createPath = $state('');
	let createBranch = $state('');
	let createBaseRef = $state('');

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') onClose();
	}

	function handleCreate(): void {
		const path = createPath.trim();
		if (!path) return;
		onCreate(path, createBranch.trim() || undefined, createBaseRef.trim() || undefined);
	}

	function resetCreateForm(): void {
		showCreateForm = false;
		createPath = '';
		createBranch = '';
		createBaseRef = '';
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Backdrop -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
	onmousedown={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
	<!-- Dialog -->
	<div
		role="dialog"
		aria-modal="true"
		aria-label="Select worktree"
		tabindex="-1"
		class="bg-popover border border-border rounded-lg shadow-xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col"
	>
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
			<div class="flex items-center gap-2">
				<GitBranch class="w-4 h-4 text-muted-foreground" />
				<h2 class="text-sm font-medium text-foreground">Select worktree</h2>
			</div>
			<button onclick={onClose} class="p-1 rounded hover:bg-muted transition-colors">
				<X class="w-4 h-4 text-muted-foreground" />
			</button>
		</div>

		<!-- Body -->
		<div class="flex-1 overflow-y-auto">
			{#if errorMessage}
				<div class="flex items-center gap-2 px-4 py-3 text-sm text-destructive bg-destructive/10 border-b border-border">
					<AlertTriangle class="w-4 h-4 shrink-0" />
					<span class="flex-1">{errorMessage}</span>
					<button
						onclick={onRefresh}
						class="px-2 py-1 text-xs rounded bg-muted hover:bg-accent transition-colors text-foreground"
					>
						Retry
					</button>
				</div>
			{/if}

			{#if isLoading}
				<div class="flex items-center justify-center py-8">
					<LoaderCircle class="w-5 h-5 animate-spin text-muted-foreground" />
				</div>
			{:else}
				<div class="py-1">
					{#each worktrees as wt (wt.path)}
						<button
							onclick={() => {
								if (!wt.isPathMissing) onSelect(wt.path);
							}}
							disabled={wt.isPathMissing}
							class="w-full text-left px-4 py-2.5 hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed {wt.isCurrent ? 'bg-accent/40' : ''}"
						>
							<div class="flex items-center gap-2">
								{#if wt.isCurrent}
									<Check class="w-3.5 h-3.5 text-status-success-foreground shrink-0" />
								{:else}
									<div class="w-3.5 h-3.5 shrink-0"></div>
								{/if}
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2">
										<span class="text-sm font-medium text-foreground truncate">{wt.branch || wt.name}</span>
										{#if wt.isMain}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">main</span>
										{/if}
										{#if wt.isPathMissing}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive">missing</span>
										{/if}
									</div>
									<div class="text-xs text-muted-foreground truncate mt-0.5">{wt.path}</div>
								</div>
							</div>
						</button>
					{/each}
				</div>

				{#if worktrees.length === 0 && !errorMessage}
					<div class="flex items-center justify-center py-6 text-sm text-muted-foreground">
						No worktrees found.
					</div>
				{/if}
			{/if}

			<!-- Create form -->
			{#if showCreateForm}
				<div class="border-t border-border px-4 py-3 space-y-2">
					<div class="text-xs font-medium text-muted-foreground">Create worktree</div>
					<input
						type="text"
						bind:value={createPath}
						placeholder="Worktree path (required)"
						class="w-full px-3 py-1.5 text-sm bg-background border border-border rounded focus-visible:ring-1 focus-visible:ring-interactive-accent focus-visible:border-interactive-accent text-foreground placeholder-muted-foreground/60"
					/>
					<div class="flex gap-2">
						<input
							type="text"
							bind:value={createBranch}
							placeholder="Branch name (optional)"
							class="flex-1 px-3 py-1.5 text-sm bg-background border border-border rounded focus-visible:ring-1 focus-visible:ring-interactive-accent focus-visible:border-interactive-accent text-foreground placeholder-muted-foreground/60"
						/>
						<input
							type="text"
							bind:value={createBaseRef}
							placeholder="Base ref (optional)"
							class="flex-1 px-3 py-1.5 text-sm bg-background border border-border rounded focus-visible:ring-1 focus-visible:ring-interactive-accent focus-visible:border-interactive-accent text-foreground placeholder-muted-foreground/60"
						/>
					</div>
					<div class="flex gap-2 justify-end">
						<button
							onclick={resetCreateForm}
							class="px-3 py-1.5 text-xs rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
						>
							Cancel
						</button>
						<button
							onclick={handleCreate}
							disabled={!createPath.trim() || isCreating}
							class="px-3 py-1.5 text-xs rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed
								{createPath.trim() && !isCreating
									? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
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
		</div>

		<!-- Footer -->
		<div class="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
			<div class="flex gap-2">
				{#if !showCreateForm}
					<button
						onclick={() => (showCreateForm = true)}
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
					>
						<Plus class="w-3 h-3" />
						Add worktree
					</button>
				{/if}
				<button
					onclick={onRefresh}
					disabled={isLoading}
					class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
				>
					<RefreshCw class="w-3 h-3 {isLoading ? 'animate-spin' : ''}" />
					Refresh
				</button>
			</div>
			<button
				onclick={onClose}
				class="px-3 py-1.5 text-xs rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
			>
				Cancel
			</button>
		</div>
	</div>
</div>
