<script lang="ts">
	// Renders a single commit row in the history view with an expandable
	// diff panel showing the commit's full patch.

	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import type { GitCommit } from '$lib/api/git';
	import { formatDiff } from './GitFileItem.svelte';

	interface GitCommitItemProps {
		commit: GitCommit;
		isExpanded: boolean;
		diff: string | undefined;
		isMobile: boolean;
		wrapText: boolean;
		onToggleExpanded: (hash: string) => void;
	}

	let {
		commit,
		isExpanded,
		diff,
		isMobile,
		wrapText,
		onToggleExpanded
	}: GitCommitItemProps = $props();
</script>

<div class="border-b border-border last:border-0">
	<button
		class="w-full flex items-start p-3 hover:bg-accent/50 cursor-pointer text-left"
		onclick={() => onToggleExpanded(commit.hash)}
	>
		<div class="mr-2 mt-1 p-0.5 hover:bg-accent rounded">
			{#if isExpanded}
				<ChevronDown class="w-3 h-3" />
			{:else}
				<ChevronRight class="w-3 h-3" />
			{/if}
		</div>
		<div class="flex-1 min-w-0">
			<div class="flex items-start justify-between gap-2">
				<div class="flex-1 min-w-0">
					<p class="text-sm font-medium truncate">{commit.message}</p>
					<p class="text-xs text-muted-foreground mt-1">
						{commit.author} &bull; {commit.date}
					</p>
				</div>
				<span class="text-xs font-mono text-muted-foreground flex-shrink-0">
					{commit.hash.substring(0, 7)}
				</span>
			</div>
		</div>
	</button>

	{#if isExpanded && diff}
		<div class="bg-muted/50">
			<div class="max-h-96 overflow-y-auto p-2">
				{#if commit.stats}
					<div class="text-xs font-mono text-muted-foreground mb-2">{commit.stats}</div>
				{/if}
				<pre class="text-xs font-mono {wrapText ? 'whitespace-pre-wrap' : 'whitespace-pre overflow-x-auto'}">{@html formatDiff(diff)}</pre>
			</div>
		</div>
	{/if}
</div>
