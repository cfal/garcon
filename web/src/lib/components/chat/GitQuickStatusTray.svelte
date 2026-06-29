<script lang="ts">
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
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
		'pointer-events-auto flex min-h-10 items-center justify-between gap-3 rounded-t-2xl border border-b-0 border-border bg-card px-3 py-2 shadow-sm sm:px-4',
	);
	const hasChanges = $derived(Boolean(summary && summary.changedFiles > 0));
	const hasDiffStats = $derived(Boolean(summary && (summary.additions > 0 || summary.deletions > 0)));
	const fileSummaryText = $derived.by(() => {
		if (!summary) return '';

		const parts: string[] = [];
		if (summary.unstagedFiles > 0) {
			parts.push(m.git_quick_status_unstaged({ count: summary.unstagedFiles }));
		}
		if (summary.stagedFiles > 0) {
			parts.push(m.git_quick_status_staged({ count: summary.stagedFiles }));
		}
		if (summary.untrackedFiles > 0) {
			parts.push(m.git_quick_status_untracked({ count: summary.untrackedFiles }));
		}

		return parts.length > 0 ? parts.join(', ') : m.git_quick_status_no_changes();
	});
</script>

{#if isVisible}
	<div class={trayClass}>
		<div
			class={panelClass}
			role="status"
			aria-live="polite"
			aria-label={summary ? undefined : lastError || m.status_loading()}
		>
			{#if summary}
				<div class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-xs">
					<span
						class="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-background/65 px-2 py-1 text-muted-foreground"
						title={summary.branch}
					>
						<GitBranch class="h-3.5 w-3.5 shrink-0" />
						<span class="max-w-32 truncate font-medium text-foreground">{summary.branch || 'HEAD'}</span>
					</span>

					{#if hasDiffStats}
						<span class="inline-flex shrink-0 items-center gap-1 tabular-nums">
							{#if summary.additions > 0}
								<span class="text-git-added">
									{m.git_quick_status_additions({ count: summary.additions })}
								</span>
							{/if}
							{#if summary.additions > 0 && summary.deletions > 0}
								<span class="text-muted-foreground">/</span>
							{/if}
							{#if summary.deletions > 0}
								<span class="text-git-deleted">
									{m.git_quick_status_deletions({ count: summary.deletions })}
								</span>
							{/if}
						</span>
					{/if}
					<span
						data-testid="quick-git-file-summary"
						class="hidden min-w-0 items-center gap-2 text-muted-foreground min-[480px]:inline-flex"
					>
						{#if hasDiffStats}
							<span class="shrink-0" aria-hidden="true">•</span>
						{/if}
						<span class="min-w-0 truncate">{fileSummaryText}</span>
					</span>

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
					<span class="hidden sm:inline">{m.git_changes_commit()}</span>
				</button>
			{:else}
				<div class="flex min-h-6 flex-1 items-center justify-center">
					{#if lastError}
						<TriangleAlert class="h-4 w-4 text-status-warning-foreground" />
						<span class="sr-only">{lastError}</span>
					{:else}
						<LoaderCircle class="h-4 w-4 animate-spin text-muted-foreground" />
						<span class="sr-only">{m.status_loading()}</span>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}
