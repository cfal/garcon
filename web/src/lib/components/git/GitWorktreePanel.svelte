<script lang="ts">
	// Panel for managing git worktrees: list, create, remove. Includes
	// strong confirmation for destructive operations.

	import GitBranch from '@lucide/svelte/icons/git-branch';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { GitWorktreeItem } from '$lib/api/git.js';

	interface GitWorktreePanelProps {
		worktrees: GitWorktreeItem[];
		isLoading: boolean;
		onCreateWorktree: (path: string, options: { branch?: string; baseRef?: string }) => Promise<boolean>;
		onRemoveWorktree: (path: string, force: boolean) => Promise<boolean>;
		onRefresh: () => void;
	}

	let {
		worktrees,
		isLoading,
		onCreateWorktree,
		onRemoveWorktree,
		onRefresh,
	}: GitWorktreePanelProps = $props();

	let showCreateForm = $state(false);
	let newPath = $state('');
	let newBranch = $state('');
	let newBaseRef = $state('');
	let isCreating = $state(false);

	let confirmRemovePath = $state<string | null>(null);
	let isRemoving = $state(false);

	async function handleCreate(): Promise<void> {
		if (!newPath.trim()) return;
		isCreating = true;
		const ok = await onCreateWorktree(newPath.trim(), {
			branch: newBranch.trim() || undefined,
			baseRef: newBaseRef.trim() || undefined,
		});
		if (ok) {
			showCreateForm = false;
			newPath = '';
			newBranch = '';
			newBaseRef = '';
		}
		isCreating = false;
	}

	async function handleRemove(wtPath: string, force: boolean): Promise<void> {
		isRemoving = true;
		const ok = await onRemoveWorktree(wtPath, force);
		if (ok) confirmRemovePath = null;
		isRemoving = false;
	}
</script>

<div class="flex flex-col gap-3 p-3">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-2">
			<FolderOpen class="w-4 h-4 text-muted-foreground" />
			<span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
				Worktrees
			</span>
		</div>
		<button
			onclick={() => { showCreateForm = !showCreateForm; }}
			class="p-1 rounded hover:bg-muted transition-colors"
			title="New worktree"
		>
			<Plus class="w-4 h-4 text-muted-foreground" />
		</button>
	</div>

	<!-- Create form -->
	{#if showCreateForm}
		<div class="border border-border rounded p-2 space-y-2 bg-muted/20">
			<input
				bind:value={newPath}
				placeholder="Worktree path (e.g. ../my-feature)"
				class="w-full text-xs p-1.5 bg-background border border-border rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			/>
			<input
				bind:value={newBranch}
				placeholder="New branch name (optional)"
				class="w-full text-xs p-1.5 bg-background border border-border rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			/>
			<input
				bind:value={newBaseRef}
				placeholder="Base ref (default: HEAD)"
				class="w-full text-xs p-1.5 bg-background border border-border rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			/>
			<div class="flex gap-2">
				<button
					onclick={handleCreate}
					disabled={!newPath.trim() || isCreating}
					class="flex-1 px-2 py-1 text-xs rounded bg-interactive-accent text-interactive-accent-foreground
						{isCreating ? 'opacity-50 cursor-wait' : 'hover:brightness-110'} transition-all"
				>
					{#if isCreating}
						<LoaderCircle class="w-3 h-3 inline animate-spin mr-1" />
					{/if}
					Create
				</button>
				<button
					onclick={() => { showCreateForm = false; }}
					class="px-2 py-1 text-xs rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
				>
					Cancel
				</button>
			</div>
		</div>
	{/if}

	<!-- Worktree list -->
	{#if isLoading}
		<div class="text-xs text-muted-foreground text-center py-4">
			<LoaderCircle class="w-4 h-4 inline animate-spin mr-1" />
			Loading worktrees...
		</div>
	{:else if worktrees.length === 0}
		<div class="text-xs text-muted-foreground text-center py-4">
			No worktrees found
		</div>
	{:else}
		<div class="space-y-1">
			{#each worktrees as wt}
				<div class="flex items-center gap-2 px-2 py-1.5 rounded text-xs
					{wt.isCurrent ? 'bg-interactive-accent/10 border border-interactive-accent/20' : 'hover:bg-muted/50'}
					{wt.isPathMissing ? 'opacity-60' : ''} transition-colors group">
					<GitBranch class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
					<div class="flex-1 min-w-0">
						<div class="truncate font-medium text-foreground">
							{wt.name}
							{#if wt.isCurrent}
								<span class="ml-1 text-[9px] text-interactive-accent">(current)</span>
							{/if}
							{#if wt.isMain}
								<span class="ml-1 text-[9px] text-muted-foreground">(main)</span>
							{/if}
						</div>
						<div class="truncate text-[10px] text-muted-foreground">{wt.path}</div>
						{#if wt.isPathMissing}
							<div class="text-[10px] text-status-error-foreground flex items-center gap-1">
								<AlertTriangle class="w-3 h-3" /> Path missing
							</div>
						{/if}
					</div>
					{#if !wt.isMain && !wt.isCurrent}
						<button
							onclick={() => { confirmRemovePath = wt.path; }}
							class="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted transition-opacity"
							title="Remove worktree"
						>
							<Trash2 class="w-3.5 h-3.5 text-muted-foreground" />
						</button>
					{/if}
				</div>

				<!-- Remove confirmation -->
				{#if confirmRemovePath === wt.path}
					<div class="ml-6 p-2 border border-status-error-border rounded bg-status-error/5 space-y-2">
						<p class="text-[10px] text-status-error-foreground flex items-center gap-1">
							<AlertTriangle class="w-3 h-3" />
							Remove this worktree?
						</p>
						<div class="flex gap-1">
							<button
								onclick={() => handleRemove(wt.path, false)}
								disabled={isRemoving}
								class="px-2 py-0.5 text-[10px] rounded bg-status-error text-status-error-foreground hover:brightness-110 transition-all"
							>
								{isRemoving ? 'Removing...' : 'Remove'}
							</button>
							<button
								onclick={() => handleRemove(wt.path, true)}
								disabled={isRemoving}
								class="px-2 py-0.5 text-[10px] rounded border border-status-error text-status-error-foreground hover:bg-status-error/10 transition-colors"
							>
								Force remove
							</button>
							<button
								onclick={() => { confirmRemovePath = null; }}
								class="px-2 py-0.5 text-[10px] rounded bg-muted text-muted-foreground"
							>
								Cancel
							</button>
						</div>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
