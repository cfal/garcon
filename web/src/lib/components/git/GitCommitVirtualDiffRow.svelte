<script lang="ts">
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { SplitDiffCellView, SplitDiffRowView } from '$lib/git/review/git-diff-rows.js';

	type DiffContentRow = Extract<GitVirtualReviewRow, { kind: 'unified-row' | 'split-row' }>;

	interface GitCommitVirtualDiffRowProps {
		row: DiffContentRow;
		fontSize: number;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let { row, fontSize, onOpenInEditor }: GitCommitVirtualDiffRowProps = $props();

	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));
	let headerFontSize = $derived(Math.max(10, Math.round(fontSize * 0.82)));

	function openAfterLine(filePath: string, line: number | null): void {
		if (line === null) return;
		onOpenInEditor?.(filePath, line);
	}

	function splitCellViews(
		view: SplitDiffRowView,
	): [SplitDiffCellView | null, SplitDiffCellView | null] {
		return [view.left, view.right];
	}
</script>

{#if row.kind === 'unified-row'}
	<div
		class="font-mono"
		style:font-size={`${fontSize}px`}
		style:line-height={`${rowLineHeight}px`}
		data-git-diff-content-row
	>
		{#if row.view.isHunkHeader}
			<div class="flex items-center gap-2 px-2 py-1 text-muted-foreground {row.view.bgClass}">
				<span class="min-w-0 flex-1 truncate" style:font-size={`${headerFontSize}px`}>
					{row.view.row.beforeText}
				</span>
			</div>
		{:else}
			<div class="grid grid-cols-[3rem_3rem_minmax(0,1fr)] {row.view.bgClass}">
				<span class="select-none border-r border-border/30 pr-2 text-right {row.view.lineNumClass}">
					{row.view.row.beforeLine ?? ''}
				</span>
				<button
					type="button"
					class="select-none border-r border-border/30 pr-2 text-right {row.view
						.lineNumClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					ondblclick={() => openAfterLine(row.file.path, row.view.row.afterLine)}
					title="Open after line in editor"
				>
					{row.view.row.afterLine ?? ''}
				</button>
				<div class="whitespace-pre-wrap break-all pl-2 pr-3">
					<span class="{row.view.textClass} select-text">{row.view.textPrefix}{row.view.text}</span>
				</div>
			</div>
		{/if}
	</div>
{:else}
	<div
		class="font-mono"
		style:font-size={`${fontSize}px`}
		style:line-height={`${rowLineHeight}px`}
		data-git-diff-content-row
	>
		{#if row.view.isHunkHeader}
			<div class="flex items-center gap-2 bg-diff-hunk-header px-2 py-1 text-muted-foreground">
				<span class="min-w-0 flex-1 truncate" style:font-size={`${headerFontSize}px`}>
					{row.view.row.headerText ?? ''}
				</span>
			</div>
		{:else}
			<div class="grid grid-cols-[3rem_minmax(0,1fr)_1px_3rem_minmax(0,1fr)]">
				{#each splitCellViews(row.view) as cellView, index}
					{#if cellView?.side === 'after'}
						<button
							type="button"
							class="select-none border-r border-border/30 pr-2 text-right {cellView.lineNumClass} {cellView.bgClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
							ondblclick={() => openAfterLine(row.file.path, cellView.cell.line)}
							title="Open after line in editor"
						>
							{cellView.cell.line ?? ''}
						</button>
					{:else}
						<span
							class="select-none border-r border-border/30 pr-2 text-right {cellView?.lineNumClass ??
								'text-muted-foreground/30'} {cellView?.bgClass ?? ''}"
						>
							{cellView?.cell.line ?? ''}
						</span>
					{/if}
					<div
						class="border-r border-border/30 pl-2 pr-2 whitespace-pre-wrap break-all {cellView?.bgClass ??
							''}"
						class:opacity-40={!cellView || cellView.cell.kind === 'empty'}
					>
						{#if cellView && cellView.cell.kind !== 'empty'}
							<span class="{cellView.textClass} select-text"
								>{cellView.textPrefix}{cellView.cell.text}</span
							>
						{/if}
					</div>
					{#if index === 0}
						<div class="bg-border/40 p-0"></div>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
{/if}
