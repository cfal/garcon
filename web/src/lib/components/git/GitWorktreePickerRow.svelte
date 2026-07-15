<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import type { GitWorktreeItem } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
	import { canonicalIsoTimestamp } from '$lib/utils/iso-timestamp.js';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp.js';

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
	class="min-w-0 max-w-full w-full overflow-hidden rounded-md px-3 py-2.5 text-left transition-colors
		{isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}
		{worktree.isPathMissing ? 'cursor-not-allowed opacity-40' : ''}
		{worktree.isCurrent ? 'ring-1 ring-interactive-accent/30' : ''}"
>
	<div class="flex min-w-0 items-start gap-2 sm:gap-3">
		<div class="flex h-5 w-5 shrink-0 items-center justify-center">
			{#if worktree.isCurrent}
				<Check class="h-4 w-4 text-interactive-accent" />
			{:else}
				<GitBranch class="h-3.5 w-3.5 text-muted-foreground" />
			{/if}
		</div>
		<div class="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:gap-3">
			<div class="min-w-0 flex-1">
				<div class="flex min-w-0 items-center gap-2">
					<span class="min-w-0 truncate text-sm font-medium"
						>{worktree.branch || worktree.name}</span
					>
					{#if worktree.isMain}
						<span
							class="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
							>main</span
						>
					{/if}
					{#if worktree.isPathMissing}
						<span
							class="shrink-0 rounded-md bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-destructive"
							>missing</span
						>
					{/if}
				</div>
				<div class="mt-0.5 truncate font-mono text-xs text-muted-foreground">
					{worktree.path}
				</div>
			</div>
			{#if modified}
				<time
					datetime={modifiedAt ?? undefined}
					title={modified.tooltip}
					class="max-w-full truncate text-[10px] text-muted-foreground sm:max-w-32 sm:shrink-0 sm:pt-0.5 sm:text-right"
				>
					{m.workspace_worktree_last_modified({ time: modified.label })}
				</time>
			{:else}
				<span
					title={m.workspace_worktree_last_modified_unavailable()}
					class="max-w-full truncate text-[10px] text-muted-foreground sm:max-w-32 sm:shrink-0 sm:pt-0.5 sm:text-right"
				>
					{m.workspace_worktree_last_modified_unavailable_short()}
				</span>
			{/if}
		</div>
	</div>
</button>
