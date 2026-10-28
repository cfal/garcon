<script lang="ts">
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitSummaryButton from '$lib/components/git/GitSummaryButton.svelte';
	import GitBranchSelector from '$lib/components/git/GitBranchSelector.svelte';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import type { GitQuickBranchSelectorControls } from './git-quick-status-tray-types.js';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';

	interface Props {
		isVisible: boolean;
		summary: GitQuickSummaryReady | null;
		isRefreshing: boolean;
		isMobile?: boolean;
		lastError?: string | null;
		branchSelector?: GitQuickBranchSelectorControls | null;
		onCommit: () => void;
		announcementsEnabled?: boolean;
	}

	let {
		isVisible,
		summary,
		isRefreshing,
		isMobile = false,
		lastError = null,
		branchSelector = null,
		onCommit,
		announcementsEnabled = true,
	}: Props = $props();

	// The cap stays out of flow while sliding underneath the rounded composer
	// edge; feed/queue reservation still owns the vertical space above.
	const trayClass = cn('absolute bottom-full left-0 right-0 z-10 translate-y-3');
	const panelClass = cn(
		'pointer-events-auto flex min-h-14 items-center justify-between gap-3 rounded-t-2xl border border-b-0 border-border bg-card px-3 pb-5 pt-2 sm:px-4',
	);
</script>

{#if isVisible}
	<div class={trayClass}>
		<div
			data-slot="chat-git-status"
			class={panelClass}
			role={announcementsEnabled ? 'status' : undefined}
			aria-live={announcementsEnabled ? 'polite' : 'off'}
			aria-busy={isRefreshing || (!summary && !lastError)}
			aria-label={summary ? undefined : lastError || m.status_loading()}
		>
			{#if summary}
				<div class="flex min-w-0 flex-1 items-center gap-2 text-xs">
					{#if branchSelector}
						<GitBranchSelector
							currentBranch={summary.branch || 'HEAD'}
							refs={branchSelector.refs}
							sort={branchSelector.sort}
							isOpen={branchSelector.isOpen}
							isLoading={branchSelector.isLoading}
							{isMobile}
							side="top"
							menuClass="w-[min(36rem,calc(100vw-2rem))]"
							triggerClass="inline-flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-md border border-border bg-background/65 px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-80"
							iconClass="h-3.5 w-3.5 shrink-0"
							labelClass="max-w-32 text-xs font-medium text-foreground"
							chevronClass="h-3.5 w-3.5"
							onToggle={branchSelector.onToggle}
							onClose={branchSelector.onClose}
							onCreateBranch={branchSelector.onCreateBranch}
							onSwitchBranch={branchSelector.onSwitchBranch}
							onSearchRefs={branchSelector.onSearchRefs}
							onSortRefs={branchSelector.onSortRefs}
							onSwitchDialogClose={branchSelector.onSwitchDialogClose}
						/>
					{:else}
						<span
							data-slot="chat-git-branch"
							class="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-background/65 px-2 py-1 text-muted-foreground"
							title={summary.branch}
						>
							<GitBranch class="h-3.5 w-3.5 shrink-0" />
							<span class="max-w-32 truncate font-medium text-foreground"
								>{summary.branch || 'HEAD'}</span
							>
						</span>
					{/if}
				</div>
			{/if}
			<GitSummaryButton {summary} {isRefreshing} {lastError} {onCommit} />
		</div>
	</div>
{/if}
