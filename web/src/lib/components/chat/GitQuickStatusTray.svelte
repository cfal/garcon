<script lang="ts">
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import { cn } from '$lib/utils/cn';

	interface Props {
		isVisible: boolean;
		summary: GitQuickSummaryReady | null;
		isRefreshing: boolean;
		lastError?: string | null;
		onCommit: () => void;
	}

	let { isVisible, summary, isRefreshing, lastError = null, onCommit }: Props = $props();

	const trayClass = cn(
		'absolute bottom-full left-[13px] right-[13px] z-10 md:left-3 md:right-3',
	);
	const panelClass = cn(
		'pointer-events-auto flex min-h-10 items-center justify-between gap-3 rounded-t-2xl bg-chat-thinking px-3 py-2 shadow-sm sm:px-4',
	);
	const totalAdditions = $derived(
		(summary?.additions ?? 0) + (summary?.untrackedAdditions ?? 0),
	);
	const hasChanges = $derived(Boolean(summary && summary.changedFiles > 0));
	const fileLabel = $derived(
		summary
			? `${summary.changedFiles} file${summary.changedFiles === 1 ? '' : 's'}`
			: '0 files',
	);
</script>

{#if isVisible && summary}
	<div class={trayClass}>
		<div class={panelClass} role="status" aria-live="polite">
			<div class="flex min-w-0 items-center gap-2 text-xs">
				<span
					class="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-background/65 px-2 py-1 text-muted-foreground"
					title={summary.branch}
				>
					<GitBranch class="h-3.5 w-3.5 shrink-0" />
					<span class="max-w-32 truncate font-medium text-foreground">{summary.branch || 'HEAD'}</span>
				</span>

				{#if hasChanges}
					<span class="shrink-0 text-muted-foreground">{fileLabel}</span>
					{#if summary.untrackedFiles > 0}
						<span class="hidden shrink-0 text-muted-foreground sm:inline">
							{summary.untrackedFiles} untracked
						</span>
					{/if}
					<span class="shrink-0 tabular-nums text-git-added">+{totalAdditions}</span>
					<span class="shrink-0 tabular-nums text-git-deleted">-{summary.deletions}</span>
				{:else}
					<span class="shrink-0 text-muted-foreground">clean</span>
				{/if}

				{#if isRefreshing}
					<LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
				{:else if lastError}
					<TriangleAlert class="h-3.5 w-3.5 shrink-0 text-status-warning-foreground" />
				{/if}
			</div>

			<button
				type="button"
				onclick={onCommit}
				disabled={!hasChanges}
				class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
					{hasChanges
					? 'bg-background/70 text-foreground hover:bg-muted'
					: 'bg-background/40 text-muted-foreground cursor-not-allowed'}"
			>
				<GitCommitHorizontal class="h-3.5 w-3.5" />
				<span class="hidden sm:inline">Commit</span>
			</button>
		</div>
	</div>
{/if}
