<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
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
		fullscreenHost: HostId | null;
	}

	let {
		snapshot,
		showFileTreeToggle,
		fileTreeVisible,
		onToggleFileTree,
		onBack,
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

<header class="border-b border-border bg-background px-3 py-2">
	<div class="flex min-w-0 items-center gap-2">
		{#if onBack}
			<button
				type="button"
				class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				aria-label={m.git_history_back_to_comparison_selection()}
				title={m.git_history_back_to_comparison_selection()}
				onclick={onBack}
			>
				<ArrowLeft class="h-4 w-4" />
			</button>
		{/if}
		<div class="min-w-0 flex-1">
			<div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
				<span class="truncate" title={snapshot.from.label}>{snapshot.from.label}</span>
				<span class="shrink-0 font-mono text-[10px]">{snapshot.from.shortHash}</span>
				<ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
				<span class="truncate" title={toLabel}>{toLabel}</span>
				<span class="shrink-0 font-mono text-[10px]">{toIdentity}</span>
			</div>
		</div>
		{#if showFileTreeToggle}
			<div class="flex shrink-0 items-center gap-1">
				<GitFileTreeToggleButton visible={fileTreeVisible} onToggle={onToggleFileTree} />
				{#if fullscreenHost}
					<WorkspaceFullscreenButton host={fullscreenHost} />
				{/if}
			</div>
		{/if}
	</div>
	<div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span
			>{snapshot.mode === 'merge-base'
				? m.git_compare_since_common_ancestor()
				: m.git_compare_direct()}</span
		>
		{#if snapshot.mergeBaseHash}<span class="font-mono"
				>{m.git_compare_merge_base({ hash: snapshot.mergeBaseHash.slice(0, 10) })}</span
			>{/if}
		<span>{m.git_compare_changed_files({ count: snapshot.files.length })}</span>
		<span class="text-git-added">+{additionsKnown ? additions : '?'}</span>
		<span class="text-git-deleted">-{additionsKnown ? deletions : '?'}</span>
	</div>
</header>
