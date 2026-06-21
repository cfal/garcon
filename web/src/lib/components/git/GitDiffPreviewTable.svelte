<script lang="ts">
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import type { GitDiffTab, GitFileReviewData, GitReviewCommentDraft } from '$lib/api/git.js';
	import type {
		GitDiffActionTarget,
		GitLineSelectionKey,
	} from '$lib/stores/git-workbench.svelte.js';
	import type { CommentComposerState } from '$lib/stores/git/git-review-drafts.svelte';
	import GitDiffCommentComposer from './GitDiffCommentComposer.svelte';
	import GitDiffCommentThread from './GitDiffCommentThread.svelte';
	import {
		buildCommentsByLineKey,
		buildSplitDiffRows,
		buildSplitDiffRowViews,
		buildUnifiedDiffRowsFromRendered,
		buildUnifiedDiffRowViews,
		getSelectableLineKeys,
		type SplitDiffCellView,
		type SplitDiffRowView,
		type UnifiedDiffRowView,
	} from './git-diff-rows';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitDiffPreviewTableProps {
		filePath: string;
		reviewData: GitFileReviewData;
		activeTab: GitDiffTab;
		diffMode: DiffMode;
		contextLines: number;
		fontSize: number;
		selectedLineKeys: Set<string>;
		operationPending: boolean;
		comments: GitReviewCommentDraft[];
		composerState: CommentComposerState;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onAddComment: (filePath: string, side: 'before' | 'after', line: number) => void;
		onEditComment: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment?: (id: string) => void;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		filePath,
		reviewData,
		activeTab,
		diffMode,
		contextLines,
		fontSize,
		selectedLineKeys,
		operationPending,
		comments,
		composerState,
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onAddComment,
		onEditComment,
		onRemoveComment,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onOpenInEditor,
	}: GitDiffPreviewTableProps = $props();

	let editingCommentId = $state<string | null>(null);
	let editBody = $state('');

	let actionTarget = $derived<GitDiffActionTarget>({
		filePath,
		tab: activeTab,
		mode: activeTab === 'unstaged' ? 'stage' : 'unstage',
		contextLines,
	});
	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));
	let headerFontSize = $derived(Math.max(10, Math.round(fontSize * 0.82)));
	let unifiedRows = $derived(buildUnifiedDiffRowsFromRendered(reviewData));
	let commentsByLineKey = $derived(buildCommentsByLineKey(comments));
	let composerTarget = $derived(
		composerState.open && composerState.filePath === filePath
			? {
					open: composerState.open,
					filePath: composerState.filePath,
					side: composerState.side,
					line: composerState.line,
					body: composerState.body,
					severity: composerState.severity,
				}
			: null,
	);
	let unifiedViews = $derived(
		buildUnifiedDiffRowViews({
			rows: unifiedRows,
			filePath,
			activeTab,
			readOnly: false,
			selectedLineKeys,
			commentsByLineKey,
			composerTarget,
		}),
	);
	let splitViews = $derived(
		buildSplitDiffRowViews({
			rows: buildSplitDiffRows(unifiedRows),
			filePath,
			activeTab,
			readOnly: false,
			selectedLineKeys,
			commentsByLineKey,
			composerTarget,
		}),
	);
	let selectableLineKeys = $derived(getSelectableLineKeys(unifiedRows, filePath, activeTab));

	function handleLineClick(event: MouseEvent | KeyboardEvent, selectionKey: string | null): void {
		if (!selectionKey) return;
		if (event.shiftKey && selectedLineKeys.size > 0) {
			const last = Array.from(selectedLineKeys).at(-1);
			if (last) onSelectLineRange(last, selectionKey, selectableLineKeys);
			return;
		}
		onToggleLineSelection(selectionKey);
	}

	function handleLineKeydown(event: KeyboardEvent, selectionKey: string | null): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		handleLineClick(event, selectionKey);
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

	function lineActionTitle(): string {
		return activeTab === 'unstaged' ? m.git_action_stage_line() : m.git_action_unstage_line();
	}

	function hunkActionTitle(): string {
		return activeTab === 'unstaged' ? m.git_action_stage_hunk() : m.git_action_unstage_hunk();
	}

	function addCommentForUnified(row: UnifiedDiffRowView): void {
		const target = row.row.kind === 'del' ? row.beforeContextTarget : row.afterContextTarget;
		if (!target) return;
		onAddComment(filePath, target.side, target.line);
	}

	function addCommentForSplit(cellView: SplitDiffCellView | null): void {
		const target = cellView?.contextTarget;
		if (!target) return;
		onAddComment(filePath, target.side, target.line);
	}

	function openEditor(line: number | null): void {
		if (line === null) return;
		onOpenInEditor?.(filePath, line);
	}
</script>

{#if unifiedRows.length === 0}
	<div class="px-3 py-5 text-xs text-muted-foreground">No text diff rows to show.</div>
{:else if diffMode === 'split'}
	<table
		class="w-full border-collapse font-mono"
		style:font-size={`${fontSize}px`}
		style:line-height={`${rowLineHeight}px`}
	>
		<tbody>
			{#each splitViews as diffRow (diffRow.key)}
				{#if diffRow.isHunkHeader}
					<tr class="bg-diff-hunk-header">
						<td colspan="5" class="px-2 py-1 text-muted-foreground">
							<div class="flex items-center gap-2" style:font-size={`${headerFontSize}px`}>
								<span class="flex-1 truncate">{diffRow.row.headerText}</span>
								<button
									type="button"
									disabled={operationPending}
									onclick={() => {
										if (activeTab === 'unstaged') onStageHunk(actionTarget, diffRow.row.hunkIndex ?? -1);
										else onUnstageHunk(actionTarget, diffRow.row.hunkIndex ?? -1);
									}}
									class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
									title={hunkActionTitle()}
								>
									{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus class="h-3 w-3" />{/if}
									{activeTab === 'unstaged' ? m.git_action_stage() : m.git_action_unstage()}
								</button>
							</div>
						</td>
					</tr>
				{:else}
					{@render splitCell(diffRow, diffRow.left)}
				{/if}
				<GitDiffCommentThread
					comments={diffRow.comments}
					colspan={5}
					{editingCommentId}
					{editBody}
					onStartEdit={startEditComment}
					onCancelEdit={cancelEditComment}
					onEditBodyChange={(body) => {
						editBody = body;
					}}
					onSaveEdit={saveEditComment}
					{onRemoveComment}
				/>
				{#if diffRow.showComposer && composerTarget}
					<GitDiffCommentComposer
						colspan={5}
						body={composerTarget.body}
						severity={composerTarget.severity}
						onBodyChange={onComposerBodyChange}
						onSeverityChange={onComposerSeverityChange}
						onSubmit={onComposerSubmit}
						onClose={onComposerClose}
					/>
				{/if}
			{/each}
		</tbody>
	</table>
{:else}
	<table
		class="w-full border-collapse font-mono"
		style:font-size={`${fontSize}px`}
		style:line-height={`${rowLineHeight}px`}
	>
		<tbody>
			{#each unifiedViews as diffRow (diffRow.key)}
				{#if diffRow.isHunkHeader}
					<tr class={diffRow.bgClass}>
						<td colspan="5" class="px-2 py-1 text-muted-foreground">
							<div class="flex items-center gap-2" style:font-size={`${headerFontSize}px`}>
								<span class="flex-1 truncate">{diffRow.row.beforeText}</span>
								<button
									type="button"
									disabled={operationPending}
									onclick={() => {
										if (activeTab === 'unstaged') onStageHunk(actionTarget, diffRow.row.hunkIndex);
										else onUnstageHunk(actionTarget, diffRow.row.hunkIndex);
									}}
									class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
									title={hunkActionTitle()}
								>
									{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus class="h-3 w-3" />{/if}
									{activeTab === 'unstaged' ? m.git_action_stage() : m.git_action_unstage()}
								</button>
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
						onclick={(event) => handleLineClick(event, diffRow.selectionKey)}
						onkeydown={(event) => handleLineKeydown(event, diffRow.selectionKey)}
					>
						<td class="w-8 select-none border-r border-border/30 p-0">
							<div class="flex items-center justify-center">
								{#if diffRow.row.kind === 'add' || diffRow.row.kind === 'del'}
									<button
										type="button"
										disabled={operationPending}
										onclick={(event) => {
											event.stopPropagation();
											if (activeTab === 'unstaged') onStageLine(actionTarget, diffRow.row.diffLineIndex);
											else onUnstageLine(actionTarget, diffRow.row.diffLineIndex);
										}}
										class="rounded p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-foreground disabled:opacity-50"
										title={lineActionTitle()}
									>
										{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus class="h-3 w-3" />{/if}
									</button>
								{/if}
							</div>
						</td>
						<td
							class="w-12 select-none border-r border-border/30 pr-2 text-right {diffRow.lineNumClass}"
							ondblclick={() => openEditor(diffRow.row.beforeLine)}
						>
							{diffRow.row.beforeLine ?? ''}
						</td>
						<td
							class="w-12 select-none border-r border-border/30 pr-2 text-right {diffRow.lineNumClass}"
							ondblclick={() => openEditor(diffRow.row.afterLine)}
						>
							{diffRow.row.afterLine ?? ''}
						</td>
						<td class="pl-2 pr-3 whitespace-pre-wrap break-all">
							<span class="{diffRow.textClass} select-text">{diffRow.textPrefix}{diffRow.text}</span>
						</td>
						<td class="w-8 p-0 pr-1 text-right">
							<button
								type="button"
								class="rounded p-0.5 text-muted-foreground/35 hover:bg-muted hover:text-foreground"
								title={m.git_comment_add()}
								onclick={(event) => {
									event.stopPropagation();
									addCommentForUnified(diffRow);
								}}
							>
								<MessageSquarePlus class="h-3 w-3" />
							</button>
						</td>
					</tr>
				{/if}
				<GitDiffCommentThread
					comments={diffRow.comments}
					colspan={5}
					{editingCommentId}
					{editBody}
					onStartEdit={startEditComment}
					onCancelEdit={cancelEditComment}
					onEditBodyChange={(body) => {
						editBody = body;
					}}
					onSaveEdit={saveEditComment}
					{onRemoveComment}
				/>
				{#if diffRow.showComposer && composerTarget}
					<GitDiffCommentComposer
						colspan={5}
						body={composerTarget.body}
						severity={composerTarget.severity}
						onBodyChange={onComposerBodyChange}
						onSeverityChange={onComposerSeverityChange}
						onSubmit={onComposerSubmit}
						onClose={onComposerClose}
					/>
				{/if}
			{/each}
		</tbody>
	</table>
{/if}

{#snippet splitCell(diffRow: SplitDiffRowView, leftCell: SplitDiffCellView | null)}
	<tr>
		{#each [leftCell, diffRow.right] as cellView, index}
			<td
				class="w-12 select-none border-r border-border/30 pr-2 text-right {cellView?.lineNumClass ?? 'text-muted-foreground/30'} {cellView?.bgClass ?? ''}"
				ondblclick={() => openEditor(cellView?.side === 'after' ? cellView.cell.line : null)}
			>
				{cellView?.cell.line ?? ''}
			</td>
			<td
				class="w-[50%] border-r border-border/30 pl-2 pr-2 whitespace-pre-wrap break-all {cellView?.bgClass ?? ''}"
				class:opacity-40={!cellView || cellView.cell.kind === 'empty'}
			>
				{#if cellView && cellView.cell.kind !== 'empty'}
					<button
						type="button"
						class="mr-1 rounded p-0.5 text-muted-foreground/35 hover:bg-muted hover:text-foreground"
						title={m.git_comment_add()}
						onclick={() => addCommentForSplit(cellView)}
					>
						<MessageSquarePlus class="inline h-3 w-3" />
					</button>
					{#if cellView.cell.kind === 'add' || cellView.cell.kind === 'del'}
						<button
							type="button"
							disabled={operationPending}
							class="mr-1 rounded p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-foreground disabled:opacity-50"
							title={lineActionTitle()}
							onclick={() => {
								if (activeTab === 'unstaged') onStageLine(actionTarget, cellView.cell.diffLineIndex);
								else onUnstageLine(actionTarget, cellView.cell.diffLineIndex);
							}}
						>
							{#if activeTab === 'unstaged'}<Plus class="inline h-3 w-3" />{:else}<Minus class="inline h-3 w-3" />{/if}
						</button>
					{/if}
					<span class="{cellView.textClass} select-text">{cellView.textPrefix}{cellView.cell.text}</span>
				{/if}
			</td>
			{#if index === 0}
				<td class="w-px bg-border/40 p-0"></td>
			{/if}
		{/each}
	</tr>
{/snippet}
