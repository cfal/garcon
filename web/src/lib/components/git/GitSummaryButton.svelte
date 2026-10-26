<script lang="ts">
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Tooltip } from 'bits-ui';
	import { getOptionalTransientLayers } from '$lib/context';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
	import { allocateTransientLayerId } from '$lib/workspace/transient-layer-id';

	interface Props {
		summary: GitQuickSummaryReady | null;
		isRefreshing: boolean;
		lastError?: string | null;
		onCommit: () => void;
	}

	let { summary, isRefreshing, lastError = null, onCommit }: Props = $props();
	const transientLayers = getOptionalTransientLayers();
	const tooltipLayerId = allocateTransientLayerId('git-summary-tooltip');
	let tooltipOpen = $state(false);
	let tooltipTrigger = $state<HTMLButtonElement | null>(null);
	let tooltipContent = $state<HTMLElement | null>(null);
	$effect(() => {
		if (!transientLayers || !tooltipOpen || !tooltipContent) return;
		return transientLayers.register({
			id: tooltipLayerId,
			kind: 'popover',
			modality: 'nonmodal',
			isOpen: () => tooltipOpen && tooltipTrigger === document.activeElement,
			element: () => tooltipContent,
			onEscape: () => {
				tooltipOpen = false;
				return true;
			},
			restoreFocus: () => {},
		});
	});
	const lineStats = $derived.by(() => {
		const stats = summary?.diffStats;
		if (stats && (stats.additions > 0 || stats.deletions > 0)) return stats;
		return null;
	});
	const description = $derived.by(() => {
		const parts: string[] = [m.git_changes_commit()];
		if (lineStats) {
			parts.push(m.git_quick_status_additions({ count: lineStats.additions }));
			parts.push(m.git_quick_status_deletions({ count: lineStats.deletions }));
		}
		if (summary?.hasUntracked) parts.push(m.git_quick_status_new_files());
		if (summary && !summary.hasChanges) parts.push(m.git_quick_status_no_changes());
		if (summary?.diffStats === null) parts.push(m.git_quick_status_stats_unavailable());
		if (lastError) parts.push(lastError);
		else if (!summary) parts.push(m.status_loading());
		return parts.join('; ');
	});
</script>

<div class="relative ml-auto shrink-0" data-git-summary-button>
	<Tooltip.Provider delayDuration={300}>
		<Tooltip.Root bind:open={tooltipOpen}>
			<Tooltip.Trigger
				bind:ref={tooltipTrigger}
				type="button"
				onclick={onCommit}
				aria-busy={isRefreshing}
				class="inline-flex h-7 max-w-full items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-background/70 px-2.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {summary?.hasChanges
					? 'text-foreground'
					: 'text-muted-foreground'}"
			>
				<span class="sr-only">{m.git_changes_commit()}</span>
				{#if !summary && !lastError}
					<LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
				{:else if lineStats}
					<span class="inline-flex items-center gap-1 tabular-nums">
						{#if lineStats.additions > 0}
							<span class="text-git-added">
								{m.git_quick_status_additions({ count: lineStats.additions })}
							</span>
						{/if}
						{#if lineStats.additions > 0 && lineStats.deletions > 0}
							<span class="text-muted-foreground">/</span>
						{/if}
						{#if lineStats.deletions > 0}
							<span class="text-git-deleted">
								{m.git_quick_status_deletions({ count: lineStats.deletions })}
							</span>
						{/if}
					</span>
				{:else if !summary?.hasUntracked}
					<GitCommitHorizontal class="size-3.5" aria-hidden="true" />
					{#if summary?.hasChanges}
						<span>{m.git_quick_status_changes()}</span>
					{/if}
				{/if}
				{#if summary?.hasUntracked}
					<FilePlus class="size-3.5" aria-hidden="true" />
					{#if !lineStats}
						<span>{m.git_quick_status_new_files()}</span>
					{/if}
				{/if}
				{#if lastError}
					<TriangleAlert class="size-3.5 text-status-warning-muted-foreground" aria-hidden="true" />
				{/if}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content
					bind:ref={tooltipContent}
					role="tooltip"
					side="top"
					align="end"
					sideOffset={4}
					collisionPadding={16}
					class="z-50 max-w-[min(24rem,calc(100vw-2rem))] whitespace-normal break-words rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
				>
					{description}
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
	</Tooltip.Provider>
</div>
