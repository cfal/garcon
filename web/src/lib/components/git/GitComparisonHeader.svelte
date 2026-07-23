<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Pencil from '@lucide/svelte/icons/pencil';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { GitComparisonSnapshotReady } from '$lib/api/git-comparison.js';
	import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
	import GitDiffSettingsMenu from './GitDiffSettingsMenu.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface GitComparisonHeaderProps {
		snapshot: GitComparisonSnapshotReady;
		isRefreshing: boolean;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: string;
		onBack: () => void;
		onEdit: () => void;
		onRefresh: () => void;
		onSetDiffMode: (mode: DiffMode) => void;
		onSetContextLines: (lines: number) => void;
		onSetDiffFontSize: (size: string) => void;
	}

	let {
		snapshot,
		isRefreshing,
		diffMode,
		contextLines,
		diffFontSize,
		onBack,
		onEdit,
		onRefresh,
		onSetDiffMode,
		onSetContextLines,
		onSetDiffFontSize,
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
		<button
			type="button"
			class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			aria-label={m.git_compare_back()}
			title={m.git_diff_document_back()}
			onclick={onBack}
		>
			<ArrowLeft class="h-4 w-4" />
		</button>
		<div class="min-w-0 flex-1">
			<h3 class="text-sm font-semibold text-foreground">{m.git_compare_title()}</h3>
			<div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
				<span class="truncate" title={snapshot.from.label}>{snapshot.from.label}</span>
				<span class="shrink-0 font-mono text-[10px]">{snapshot.from.shortHash}</span>
				<ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
				<span class="truncate" title={toLabel}>{toLabel}</span>
				<span class="shrink-0 font-mono text-[10px]">{toIdentity}</span>
			</div>
		</div>
		<button
			type="button"
			class="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			onclick={onEdit}
		>
			<Pencil class="h-3.5 w-3.5" />
			{m.git_compare_edit()}
		</button>
		{#if snapshot.to.kind === 'working-tree'}
			<button
				type="button"
				class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				disabled={isRefreshing}
				aria-label={m.git_compare_refresh()}
				title={m.git_compare_refresh()}
				onclick={onRefresh}
			>
				<RefreshCw class="h-4 w-4 {isRefreshing ? 'animate-spin' : ''}" />
			</button>
		{/if}
		<GitDiffSettingsMenu
			{diffMode}
			{contextLines}
			{diffFontSize}
			{onSetDiffMode}
			{onSetContextLines}
			{onSetDiffFontSize}
		/>
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
