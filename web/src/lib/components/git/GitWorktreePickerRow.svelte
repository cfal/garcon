<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import type { GitWorktreeItem } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
	import { canonicalIsoTimestamp } from '$lib/utils/iso-timestamp.js';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp.js';
	import { worktreeDisplayName } from './git-worktree-picker-state.svelte.js';

	interface Props {
		worktree: GitWorktreeItem;
		index: number;
		setSize: number;
		rowHeight: number;
		optionId: string;
		isSelected: boolean;
		currentTime: Date;
		onActivate: (worktreePath: string) => void;
		onSelect: (worktreePath: string) => void;
	}

	let {
		worktree,
		index,
		setSize,
		rowHeight,
		optionId,
		isSelected,
		currentTime,
		onActivate,
		onSelect,
	}: Props = $props();

	let modifiedAt = $derived(canonicalIsoTimestamp(worktree.lastModifiedAt));
	let modified = $derived(formatRelativeTimestamp(modifiedAt, currentTime));
</script>

<button
	id={optionId}
	data-worktree-index={index}
	type="button"
	role="option"
	tabindex="-1"
	aria-selected={isSelected}
	aria-posinset={index + 1}
	aria-setsize={setSize}
	disabled={worktree.isPathMissing}
	style={`height:${rowHeight}px;`}
	onclick={() => onSelect(worktree.path)}
	onmousemove={() => onActivate(worktree.path)}
	class="min-w-0 max-w-full w-full overflow-hidden rounded-md px-3 py-2 text-left transition-colors
		{isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}
		{worktree.isPathMissing ? 'cursor-not-allowed opacity-40' : ''}"
>
	<div class="flex min-w-0 items-center gap-2 sm:gap-3">
		{#if worktree.isCurrent}
			<Check class="size-4 shrink-0 text-interactive-accent" />
			<span class="sr-only">{m.git_worktree_current()}</span>
		{:else}
			<GitBranch class="size-4 shrink-0 text-muted-foreground" />
		{/if}
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 items-center gap-2">
				<span class="min-w-0 flex-1 truncate text-sm font-medium">{worktreeDisplayName(worktree)}</span>
				{#if worktree.isMain}
					<span class="shrink-0 text-xs text-muted-foreground">{m.git_worktree_repo()}</span>
				{/if}
				{#if worktree.isPathMissing}
					<span class="shrink-0 text-xs text-destructive">{m.git_worktree_missing()}</span>
				{/if}
				{#if modified}
					<time
						datetime={modifiedAt ?? undefined}
						title={modified.tooltip}
						class="max-w-[33%] truncate text-xs text-muted-foreground"
					>
						{m.workspace_worktree_last_modified({ time: modified.label })}
					</time>
				{:else}
					<span
						title={m.workspace_worktree_last_modified_unavailable()}
						class="truncate text-xs text-muted-foreground"
					>
						{m.workspace_worktree_last_modified_unavailable_short()}
					</span>
				{/if}
			</div>
			<div class="truncate font-mono text-xs text-muted-foreground" title={worktree.path}>
				{worktree.path}
			</div>
		</div>
	</div>
</button>
