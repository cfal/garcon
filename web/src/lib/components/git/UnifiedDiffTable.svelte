<script lang="ts">
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import { untrack } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type { GitDiffTab, GitReviewCommentDraft } from '$lib/api/git.js';
	import type { GitDiffActionTarget } from '$lib/stores/git-workbench.svelte.js';
	import GitDiffCommentComposer from './GitDiffCommentComposer.svelte';
	import GitDiffCommentThread from './GitDiffCommentThread.svelte';
	import {
		DIFF_TABLE_FALLBACK_VIEWPORT_HEIGHT,
		DIFF_TABLE_OVERSCAN,
		estimateDiffVirtualRowSize,
		measureDiffVirtualRowElement,
		observeDiffTableElementRect,
	} from './git-diff-virtual-table';
	import type {
		GitDiffComposerDraft,
		GitDiffLineContextTarget,
		UnifiedDiffRowView,
	} from './git-diff-rows';
	import * as m from '$lib/paraglide/messages.js';

	interface UnifiedDiffTableProps {
		rows: UnifiedDiffRowView[];
		activeTab: GitDiffTab;
		actionTarget: GitDiffActionTarget;
		readOnly: boolean;
		headerFontSize: number;
		rowLineHeight: number;
		colCount: number;
		composer: GitDiffComposerDraft | null;
		showLineActions: boolean;
		operationPending?: boolean;
		viewportRef: HTMLDivElement | null;
		overscan?: number;
		onLineClick: (event: MouseEvent | KeyboardEvent, row: UnifiedDiffRowView) => void;
		onLineKeydown: (event: KeyboardEvent, row: UnifiedDiffRowView) => void;
		onOpenContextMenu: (event: MouseEvent, target: GitDiffLineContextTarget | null) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine?: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine?: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		editingCommentId: string | null;
		editBody: string;
		onStartEditComment: (comment: GitReviewCommentDraft) => void;
		onCancelEditComment: () => void;
		onEditCommentBodyChange: (body: string) => void;
		onSaveEditComment: (commentId: string) => void;
		onRemoveComment?: (id: string) => void;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
	}

	let {
		rows,
		activeTab,
		actionTarget,
		readOnly,
		headerFontSize,
		rowLineHeight,
		colCount,
		composer,
		showLineActions,
		operationPending = false,
		viewportRef,
		overscan = DIFF_TABLE_OVERSCAN,
		onLineClick,
		onLineKeydown,
		onOpenContextMenu,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		editingCommentId,
		editBody,
		onStartEditComment,
		onCancelEditComment,
		onEditCommentBodyChange,
		onSaveEditComment,
		onRemoveComment,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
	}: UnifiedDiffTableProps = $props();

	function estimateRowSize(index: number): number {
		return estimateDiffVirtualRowSize(rows[index], rowLineHeight);
	}

	function measureRowElement(element: HTMLTableSectionElement): number {
		return measureDiffVirtualRowElement(element, rows, rowLineHeight);
	}

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLTableSectionElement>({
		count: 0,
		getScrollElement: () => viewportRef,
		estimateSize: estimateRowSize,
		measureElement: measureRowElement,
		observeElementRect: observeDiffTableElementRect,
		initialRect: { width: 0, height: DIFF_TABLE_FALLBACK_VIEWPORT_HEIGHT },
		overscan: 0,
		getItemKey: (index) => rows[index]?.key ?? index,
	});

	let virtualItems = $derived($virtualizer.getVirtualItems());
	let totalHeight = $derived($virtualizer.getTotalSize());
	let firstVirtualItem = $derived(virtualItems[0]);
	let lastVirtualItem = $derived(virtualItems[virtualItems.length - 1]);
	let topSpacerHeight = $derived(firstVirtualItem?.start ?? 0);
	let bottomSpacerHeight = $derived(
		Math.max(0, totalHeight - ((lastVirtualItem?.start ?? 0) + (lastVirtualItem?.size ?? 0))),
	);

	$effect(() => {
		const count = rows.length;
		const scrollElement = viewportRef;
		const rowOverscan = overscan;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				estimateSize: estimateRowSize,
				measureElement: measureRowElement,
				observeElementRect: observeDiffTableElementRect,
				initialRect: { width: 0, height: DIFF_TABLE_FALLBACK_VIEWPORT_HEIGHT },
				overscan: rowOverscan,
				getItemKey: (index) => rows[index]?.key ?? index,
			});
		});
	});

	function measureVirtualItem(element: HTMLTableSectionElement): { destroy: () => void } {
		$virtualizer.measureElement(element);
		return {
			destroy() {
				$virtualizer.measureElement(null);
			},
		};
	}
</script>

<table class="w-full border-collapse">
	{#if topSpacerHeight > 0}
		<tbody aria-hidden="true">
			<tr>
				<td colspan={colCount} class="p-0 border-0" style:height={`${topSpacerHeight}px`}></td>
			</tr>
		</tbody>
	{/if}
	{#each virtualItems as virtualItem (rows[virtualItem.index]?.key ?? virtualItem.key)}
		{@const diffRow = rows[virtualItem.index]}
		{#if diffRow}
			<tbody data-index={virtualItem.index} use:measureVirtualItem>
				{#if diffRow.isHunkHeader}
					<tr class={diffRow.bgClass}>
						<td colspan={colCount} class="px-2 py-1 text-muted-foreground">
							<div class="flex items-center gap-2" style:font-size={`${headerFontSize}px`}>
								<span class="flex-1 truncate">{diffRow.row.beforeText}</span>
								{#if !readOnly}
									{#if activeTab === 'unstaged'}
										<button
											type="button"
											disabled={operationPending}
											onclick={() => onStageHunk(actionTarget, diffRow.row.hunkIndex)}
											class="px-1.5 py-0.5 text-[10px] rounded bg-git-added/20 text-git-added hover:bg-git-added/30 transition-colors disabled:opacity-50"
											title={m.git_action_stage_hunk()}
										>
											<Plus class="w-3 h-3 inline" />
											{m.git_action_stage()}
										</button>
									{:else}
										<button
											type="button"
											disabled={operationPending}
											onclick={() => onUnstageHunk(actionTarget, diffRow.row.hunkIndex)}
											class="px-1.5 py-0.5 text-[10px] rounded bg-git-deleted/20 text-git-deleted hover:bg-git-deleted/30 transition-colors disabled:opacity-50"
											title={m.git_action_unstage_hunk()}
										>
											<Minus class="w-3 h-3 inline" />
											{m.git_action_unstage()}
										</button>
									{/if}
								{/if}
							</div>
						</td>
					</tr>
				{:else}
					<tr
						class="select-none {diffRow.bgClass} {diffRow.isSelectable
							? 'cursor-pointer hover:brightness-95'
							: ''}"
						tabindex={diffRow.isSelectable ? 0 : -1}
						role={diffRow.isSelectable ? 'button' : undefined}
						onclick={(event) => onLineClick(event, diffRow)}
						onkeydown={(event) => onLineKeydown(event, diffRow)}
						oncontextmenu={(event) => onOpenContextMenu(event, diffRow.rowContextTarget)}
					>
						{#if showLineActions}
							<td class="w-8 select-none border-r border-border/30 p-0">
								<div class="flex items-center justify-center leading-5">
									{#if diffRow.row.kind === 'add' || diffRow.row.kind === 'del'}
										{#if activeTab === 'unstaged'}
											<button
												type="button"
												disabled={operationPending}
												onclick={(event) => {
													event.stopPropagation();
													onStageLine?.(actionTarget, diffRow.row.diffLineIndex);
												}}
												class="flex items-center justify-center text-muted-foreground/30 hover:text-git-added hover:bg-git-added/20 transition-colors rounded p-0.5 disabled:opacity-50"
												title={m.git_action_stage_line()}
											>
												<Plus class="w-3 h-3" />
											</button>
										{:else}
											<button
												type="button"
												disabled={operationPending}
												onclick={(event) => {
													event.stopPropagation();
													onUnstageLine?.(actionTarget, diffRow.row.diffLineIndex);
												}}
												class="flex items-center justify-center text-muted-foreground/30 hover:text-git-deleted hover:bg-git-deleted/20 transition-colors rounded p-0.5 disabled:opacity-50"
												title={m.git_action_unstage_line()}
											>
												<Minus class="w-3 h-3" />
											</button>
										{/if}
									{/if}
								</div>
							</td>
						{/if}
						<td
							class="w-12 text-right pr-2 select-none {diffRow.lineNumClass} border-r border-border/30 {diffRow.beforeContextTarget
								? 'cursor-pointer hover:bg-interactive-accent/10'
								: ''}"
							onclick={(event) => {
								if (!diffRow.beforeContextTarget) return;
								onOpenContextMenu(event, diffRow.beforeContextTarget);
							}}
						>
							{diffRow.row.beforeLine ?? ''}
						</td>
						<td
							class="w-12 text-right pr-2 select-none {diffRow.lineNumClass} border-r border-border/30 {diffRow.afterContextTarget
								? 'cursor-pointer hover:bg-interactive-accent/10'
								: ''}"
							onclick={(event) => {
								if (!diffRow.afterContextTarget) return;
								onOpenContextMenu(event, diffRow.afterContextTarget);
							}}
						>
							{diffRow.row.afterLine ?? ''}
						</td>
						<td class="pl-2 pr-3 whitespace-pre-wrap break-all">
							<span class="{diffRow.textClass} select-text">{diffRow.textPrefix}{diffRow.text}</span
							>
						</td>
					</tr>
					<GitDiffCommentThread
						comments={diffRow.comments}
						colspan={colCount}
						{editingCommentId}
						{editBody}
						onStartEdit={onStartEditComment}
						onCancelEdit={onCancelEditComment}
						onEditBodyChange={onEditCommentBodyChange}
						onSaveEdit={onSaveEditComment}
						{onRemoveComment}
					/>
					{#if diffRow.showComposer && composer}
						<GitDiffCommentComposer
							colspan={colCount}
							body={composer.body}
							severity={composer.severity}
							onBodyChange={onComposerBodyChange}
							onSeverityChange={onComposerSeverityChange}
							onSubmit={onComposerSubmit}
							onClose={onComposerClose}
						/>
					{/if}
				{/if}
			</tbody>
		{/if}
	{/each}
	{#if bottomSpacerHeight > 0}
		<tbody aria-hidden="true">
			<tr>
				<td colspan={colCount} class="p-0 border-0" style:height={`${bottomSpacerHeight}px`}></td>
			</tr>
		</tbody>
	{/if}
</table>
