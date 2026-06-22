<script lang="ts">
	import { untrack } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type { GitDiffTab, GitReviewCommentDraft } from '$lib/api/git.js';
	import type {
		GitDiffActionTarget,
		GitVirtualReviewRow,
	} from '$lib/stores/git-workbench.svelte.js';
	import type { CommentComposerState } from '$lib/stores/git/git-review-drafts.svelte';
	import GitVirtualDiffRow from './GitVirtualDiffRow.svelte';
	import GitVirtualFileHeader from './GitVirtualFileHeader.svelte';
	import GitVirtualPlaceholderRow from './GitVirtualPlaceholderRow.svelte';

	interface GitVirtualDiffSurfaceProps {
		rows: GitVirtualReviewRow[];
		fileRowIndex: Map<string, number>;
		activeTab: GitDiffTab;
		fontSize: number;
		selectedLineKeys: Set<string>;
		operationPending: boolean;
		scrollToRequest: { filePath: string; token: number } | null;
		composerState: CommentComposerState;
		overscan?: number;
		onVisibleRowsChange: (rows: GitVirtualReviewRow[]) => void;
		onSelectFile: (filePath: string) => void;
		onToggleViewed: (filePath: string) => void;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onAddCommentForFile: (filePath: string, side: 'before' | 'after', line: number) => void;
		onEditComment: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment?: (id: string) => void;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		rows,
		fileRowIndex,
		activeTab,
		fontSize,
		selectedLineKeys,
		operationPending,
		scrollToRequest,
		composerState,
		overscan = 18,
		onVisibleRowsChange,
		onSelectFile,
		onToggleViewed,
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onAddCommentForFile,
		onEditComment,
		onRemoveComment,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onOpenInEditor,
	}: GitVirtualDiffSurfaceProps = $props();

	let viewportRef = $state<HTMLDivElement | null>(null);
	let lastVisibleRequestKey = '';
	let lastScrollToken = 0;
	let editingCommentId = $state<string | null>(null);
	let editBody = $state('');

	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));

	interface VirtualRowItem {
		index: number;
		key: string | number | bigint;
		start: number;
		size: number;
		end: number;
	}

	function estimateRowHeight(index: number): number {
		const row = rows[index];
		if (!row) return rowLineHeight;
		if (row.kind === 'unified-row' || row.kind === 'split-row') {
			return Math.max(row.estimatedHeight, rowLineHeight);
		}
		return row.estimatedHeight;
	}

	const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewportRef,
		estimateSize: estimateRowHeight,
		measureElement: (element) => element.getBoundingClientRect().height,
		initialRect: { width: 0, height: 720 },
		overscan: 18,
		getItemKey: (index) => rows[index]?.id ?? index,
	});

	let virtualItems = $derived($virtualizer.getVirtualItems());
	let renderedVirtualItems = $derived.by<VirtualRowItem[]>(() => {
		if (virtualItems.length > 0 || rows.length === 0) return virtualItems;
		const itemCount = Math.min(rows.length, Math.max(1, overscan * 2));
		let start = 0;
		return Array.from({ length: itemCount }, (_, index) => {
			const size = estimateRowHeight(index);
			const item = {
				index,
				key: rows[index]?.id ?? index,
				start,
				size,
				end: start + size,
			};
			start += size;
			return item;
		});
	});
	let totalHeight = $derived($virtualizer.getTotalSize());
	let visibleRows = $derived.by(() =>
		renderedVirtualItems
			.map((virtualItem) => rows[virtualItem.index])
			.filter((row): row is GitVirtualReviewRow => Boolean(row)),
	);

	$effect(() => {
		const count = rows.length;
		const scrollElement = viewportRef;
		const rowOverscan = overscan;
		const lineHeight = rowLineHeight;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				estimateSize: (index) => {
					const row = rows[index];
					if (!row) return lineHeight;
					if (row.kind === 'unified-row' || row.kind === 'split-row') {
						return Math.max(row.estimatedHeight, lineHeight);
					}
					return row.estimatedHeight;
				},
				measureElement: (element) => element.getBoundingClientRect().height,
				initialRect: { width: 0, height: 720 },
				overscan: rowOverscan,
				getItemKey: (index) => rows[index]?.id ?? index,
			});
		});
	});

	$effect(() => {
		const key = visibleRows.map((row) => row.id).join('\0');
		if (key === lastVisibleRequestKey) return;
		lastVisibleRequestKey = key;
		const rowsForLoad = visibleRows;
		untrack(() => onVisibleRowsChange(rowsForLoad));
	});

	$effect(() => {
		if (!scrollToRequest || scrollToRequest.token === lastScrollToken) return;
		const targetIndex = fileRowIndex.get(scrollToRequest.filePath);
		if (targetIndex === undefined) return;
		lastScrollToken = scrollToRequest.token;
		const start = Math.max(0, targetIndex - 6);
		const end = Math.min(rows.length, targetIndex + 36);
		const priorityRows = rows.slice(start, end);
		untrack(() => {
			onVisibleRowsChange(priorityRows);
			$virtualizer.scrollToIndex(targetIndex, { align: 'start' });
		});
	});

	function measureRow(element: HTMLDivElement): { destroy: () => void } {
		$virtualizer.measureElement(element);
		return {
			destroy() {
				$virtualizer.measureElement(null);
			},
		};
	}

	function startEditComment(comment: GitReviewCommentDraft): void {
		editingCommentId = comment.id;
		editBody = comment.body;
	}

	function cancelEditComment(): void {
		editingCommentId = null;
		editBody = '';
	}

	function saveEditComment(commentId: string): void {
		onEditComment(commentId, { body: editBody });
		cancelEditComment();
	}
</script>

<div
	bind:this={viewportRef}
	class="min-h-0 flex-1 overflow-auto bg-muted/15"
	data-git-virtual-diff-root
>
	{#if rows.length === 0}
		<div class="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
			No files match the current filters.
		</div>
	{:else}
		<div class="relative w-full" style:height={`${totalHeight}px`}>
			{#each renderedVirtualItems as virtualItem (rows[virtualItem.index]?.id ?? virtualItem.key)}
				{@const row = rows[virtualItem.index]}
				{#if row}
					<div
						data-index={virtualItem.index}
						data-git-virtual-row
						use:measureRow
						class="absolute left-0 top-0 w-full"
						style:transform={`translateY(${virtualItem.start}px)`}
					>
						<svelte:boundary>
							{#if row.kind === 'file-header'}
								<GitVirtualFileHeader {row} {onSelectFile} {onToggleViewed} />
							{:else if row.kind === 'file-placeholder' || row.kind === 'file-limit' || row.kind === 'collection-limit'}
								<GitVirtualPlaceholderRow {row} />
							{:else}
								<GitVirtualDiffRow
									{row}
									{activeTab}
									{fontSize}
									{selectedLineKeys}
									{operationPending}
									{composerState}
									{editingCommentId}
									{editBody}
									onStartEdit={startEditComment}
									onCancelEdit={cancelEditComment}
									onEditBodyChange={(body) => {
										editBody = body;
									}}
									onSaveEdit={saveEditComment}
									{onRemoveComment}
									{onToggleLineSelection}
									{onSelectLineRange}
									{onStageHunk}
									{onUnstageHunk}
									{onStageLine}
									{onUnstageLine}
									{onAddCommentForFile}
									{onComposerBodyChange}
									{onComposerSeverityChange}
									{onComposerSubmit}
									{onComposerClose}
									{onOpenInEditor}
								/>
							{/if}
							{#snippet failed(error)}
								<div class="border border-status-error-border bg-status-error/10 px-3 py-2 text-xs text-status-error-foreground">
									Failed to render diff row: {error instanceof Error ? error.message : String(error)}
								</div>
							{/snippet}
						</svelte:boundary>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
