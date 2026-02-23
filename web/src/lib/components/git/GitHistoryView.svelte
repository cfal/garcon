<script lang="ts">
	// Renders the History tab: a scrollable list of recent commits with
	// expandable diffs.

	import * as m from '$lib/paraglide/messages.js';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import History from '@lucide/svelte/icons/history';
	import GitCommitItem from './GitCommitItem.svelte';
	import type { GitCommit } from '$lib/api/git';

	interface GitHistoryViewProps {
		isMobile: boolean;
		isLoading: boolean;
		recentCommits: GitCommit[];
		expandedCommits: Set<string>;
		commitDiffs: Record<string, string>;
		wrapText: boolean;
		onToggleCommitExpanded: (hash: string) => void;
	}

	let {
		isMobile,
		isLoading,
		recentCommits,
		expandedCommits,
		commitDiffs,
		wrapText,
		onToggleCommitExpanded
	}: GitHistoryViewProps = $props();
</script>

<div class="flex-1 overflow-y-auto {isMobile ? 'pb-16' : ''}">
	{#if isLoading}
		<div class="flex items-center justify-center h-32">
			<RefreshCw class="w-6 h-6 animate-spin text-muted-foreground" />
		</div>
	{:else if recentCommits.length === 0}
		<div class="flex flex-col items-center justify-center h-32 text-muted-foreground">
			<History class="w-12 h-12 mb-2 opacity-50" />
			<p class="text-sm">{m.git_history_no_commits()}</p>
		</div>
	{:else}
		<div class={isMobile ? 'pb-4' : ''}>
			{#each recentCommits as commit (commit.hash)}
				<GitCommitItem
					{commit}
					isExpanded={expandedCommits.has(commit.hash)}
					diff={commitDiffs[commit.hash]}
					{isMobile}
					{wrapText}
					onToggleExpanded={onToggleCommitExpanded}
				/>
			{/each}
		</div>
	{/if}
</div>
