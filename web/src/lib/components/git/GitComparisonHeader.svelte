<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Pencil from '@lucide/svelte/icons/pencil';
	import type { GitComparisonSnapshotReady } from '$lib/api/git-comparison.js';
	import type { HostId } from '$lib/workspace/surface-types.js';
	import WorkspaceFullscreenButton from '$lib/components/workspace/WorkspaceFullscreenButton.svelte';
	import GitFileTreeToggleButton from './GitFileTreeToggleButton.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface GitComparisonHeaderProps {
		snapshot: GitComparisonSnapshotReady;
		showFileTreeToggle: boolean;
		fileTreeVisible: boolean;
		onToggleFileTree: () => void;
		onBack?: () => void;
		onEdit?: () => void;
		fullscreenHost: HostId | null;
	}

	let {
		snapshot,
		showFileTreeToggle,
		fileTreeVisible,
		onToggleFileTree,
		onBack,
		onEdit,
		fullscreenHost,
	}: GitComparisonHeaderProps = $props();
	let additions = $derived(snapshot.files.reduce((sum, file) => sum + file.additions, 0));
	let additionsKnown = $derived(snapshot.files.every((file) => file.statsKnown !== false));
	let deletions = $derived(snapshot.files.reduce((sum, file) => sum + file.deletions, 0));
	let toLabel = $derived(
		snapshot.to.kind === 'working-tree' ? snapshot.to.label : snapshot.to.label,
	);
	let toIdentity = $derived(
		snapshot.to.kind === 'working-tree' ? snapshot.to.shortFingerprint : snapshot.to.shortHash,
	);
</script>

{#snippet rangeEndpoints()}
	<span class="truncate" title={snapshot.from.label} data-git-comparison-range-label
		>{snapshot.from.label}</span
	>
	<span class="shrink-0">{snapshot.from.shortHash}</span>
	<ArrowRight class="h-3.5 w-3.5 self-center" aria-hidden="true" />
	<span class="truncate" title={toLabel}>{toLabel}</span>
	<span class="shrink-0">{toIdentity}</span>
{/snippet}

<header class="border-b border-border bg-background px-3 py-1.5">
	<div class="flex min-w-0 items-center gap-2" data-git-comparison-header-row>
		{#if onBack}
			<button
				type="button"
				class="self-start rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				aria-label={m.git_history_back_to_comparison_selection()}
				title={m.git_history_back_to_comparison_selection()}
				onclick={onBack}
			>
				<ArrowLeft class="h-4 w-4" />
			</button>
		{/if}
		<div
			class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-8 gap-y-0.5 overflow-hidden font-mono text-xs text-muted-foreground"
			data-git-comparison-summary
		>
			{#if onEdit}
				<button
					type="button"
					class="flex min-w-0 max-w-full shrink cursor-pointer items-baseline gap-1.5 rounded py-1 text-left hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
					data-git-comparison-range
					onclick={onEdit}
				>
					{@render rangeEndpoints()}
					<Pencil class="h-3 w-3 shrink-0 self-center opacity-60" aria-hidden="true" />
					<span class="sr-only">{m.git_compare_edit_comparison()}</span>
				</button>
			{:else}
				<div class="flex min-w-0 max-w-full shrink items-baseline gap-1.5" data-git-comparison-range>
					{@render rangeEndpoints()}
				</div>
			{/if}
			<div
				class="relative flex max-w-full shrink flex-wrap items-baseline gap-x-2 gap-y-0.5"
				data-git-comparison-stats
			>
				<span
					class="pointer-events-none absolute right-full top-1/2 mr-3 -translate-y-1/2"
					aria-hidden="true"
					data-git-comparison-separator>&bull;</span
				>
				{#if snapshot.mode === 'merge-base'}
					<span>{m.git_compare_since_common_ancestor()}</span>
					{#if snapshot.mergeBaseHash}
						<span>{m.git_compare_merge_base({ hash: snapshot.mergeBaseHash.slice(0, 10) })}</span>
					{/if}
				{/if}
				<span data-git-comparison-primary-stat
					>{m.git_compare_changed_files({ count: snapshot.files.length })}</span
				>
				<span class="text-git-added">+{additionsKnown ? additions : '?'}</span>
				<span class="text-git-deleted">-{additionsKnown ? deletions : '?'}</span>
			</div>
		</div>
		{#if showFileTreeToggle}
			<div class="flex shrink-0 self-start items-center gap-1" data-git-comparison-actions>
				<GitFileTreeToggleButton visible={fileTreeVisible} onToggle={onToggleFileTree} />
				{#if fullscreenHost}
					<WorkspaceFullscreenButton host={fullscreenHost} />
				{/if}
			</div>
		{/if}
	</div>
</header>
