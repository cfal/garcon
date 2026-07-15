<script lang="ts">
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import type { GitDiffTab, GitReviewCommentDraft } from '$lib/api/git.js';
	import type { CommentComposerState } from '$lib/git/review/git-review-drafts.svelte.js';
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { GitDiffActionTarget } from '$lib/git/workbench/git-workbench-types.js';
	import type {
		GitDiffLineContextTarget,
		SplitDiffCellView,
		SplitDiffRowView,
		UnifiedDiffRowView,
	} from '$lib/git/review/git-diff-rows.js';
	import GitVirtualCommentComposer from './GitVirtualCommentComposer.svelte';
	import GitVirtualCommentThread from './GitVirtualCommentThread.svelte';
	import * as m from '$lib/paraglide/messages.js';

	type DiffContentRow = Extract<GitVirtualReviewRow, { kind: 'unified-row' | 'split-row' }>;

	interface GitVirtualDiffRowProps {
		row: DiffContentRow;
		activeTab: GitDiffTab;
		fontSize: number;
		selectedLineKeys: Set<string>;
		operationPending: boolean;
		composerState: CommentComposerState;
		editingCommentId: string | null;
		editBody: string;
		onStartEdit: (comment: GitReviewCommentDraft) => void;
		onCancelEdit: () => void;
		onEditBodyChange: (body: string) => void;
		onSaveEdit: (commentId: string) => void;
		onRemoveComment?: (id: string) => void;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onAddCommentForFile: (filePath: string, side: 'before' | 'after', line: number) => void;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		row,
		activeTab,
		fontSize,
		selectedLineKeys,
		operationPending,
		composerState,
		editingCommentId,
		editBody,
		onStartEdit,
		onCancelEdit,
		onEditBodyChange,
		onSaveEdit,
		onRemoveComment,
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onAddCommentForFile,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onOpenInEditor,
	}: GitVirtualDiffRowProps = $props();

	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));
	let headerFontSize = $derived(Math.max(10, Math.round(fontSize * 0.82)));

	function selectLine(
		event: MouseEvent | KeyboardEvent,
		selectionKey: string | null,
		selectableLineKeys: string[],
	): void {
		if (!selectionKey) return;
		if (event.shiftKey && selectedLineKeys.size > 0) {
			const last = Array.from(selectedLineKeys).at(-1);
			if (last) onSelectLineRange(last, selectionKey, selectableLineKeys);
			return;
		}
		onToggleLineSelection(selectionKey);
	}

	function hasSelectedText(container: EventTarget | null): boolean {
		if (!(container instanceof Node)) return false;
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
		return container.contains(selection.getRangeAt(0).commonAncestorContainer);
	}

	function usesLineSelectionModifier(event: MouseEvent | KeyboardEvent): boolean {
		return event.shiftKey || event.ctrlKey || event.metaKey;
	}

	function openReview(filePath: string, target: GitDiffLineContextTarget | null): void {
		if (!target) return;
		onAddCommentForFile(filePath, target.side, target.line);
	}

	function handleReviewClick(
		event: MouseEvent,
		filePath: string,
		target: GitDiffLineContextTarget | null,
		selectionKey: string | null,
		selectableLineKeys: string[],
	): void {
		if (hasSelectedText(event.currentTarget)) return;
		if (usesLineSelectionModifier(event) && selectionKey) {
			selectLine(event, selectionKey, selectableLineKeys);
			return;
		}
		openReview(filePath, target);
	}

	function startHunkAction(actionTarget: GitDiffActionTarget, hunkIndex: number): void {
		if (activeTab === 'unstaged') onStageHunk(actionTarget, hunkIndex);
		else onUnstageHunk(actionTarget, hunkIndex);
	}

	function startLineAction(actionTarget: GitDiffActionTarget, diffLineIndex: number): void {
		if (activeTab === 'unstaged') onStageLine(actionTarget, diffLineIndex);
		else onUnstageLine(actionTarget, diffLineIndex);
	}

	function lineActionTitle(): string {
		return activeTab === 'unstaged' ? m.git_action_stage_line() : m.git_action_unstage_line();
	}

	function hunkActionTitle(): string {
		return activeTab === 'unstaged' ? m.git_action_stage_hunk() : m.git_action_unstage_hunk();
	}

	function unifiedReviewTarget(view: UnifiedDiffRowView): GitDiffLineContextTarget | null {
		return view.row.kind === 'del' ? view.beforeContextTarget : view.afterContextTarget;
	}

	function splitReviewTarget(cellView: SplitDiffCellView | null): GitDiffLineContextTarget | null {
		return cellView?.contextTarget ?? null;
	}

	function openEditor(filePath: string, line: number | null): void {
		if (line === null) return;
		onOpenInEditor?.(filePath, line);
	}

	function splitCellViews(
		view: SplitDiffRowView,
	): [SplitDiffCellView | null, SplitDiffCellView | null] {
		return [view.left, view.right];
	}
</script>

{#snippet reviewAffordance(filePath: string, target: GitDiffLineContextTarget | null)}
	{#if target}
		<button
			type="button"
			data-git-comment-affordance
			class="absolute right-1 top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center rounded border border-border bg-background/95 p-0.5 text-muted-foreground opacity-100 shadow-sm transition-[color,background-color,opacity] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/diff-cell:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/diff-cell:opacity-100"
			title={m.git_comment_add()}
			aria-label={m.git_comment_add()}
			onclick={() => openReview(filePath, target)}
		>
			<MessageSquarePlus class="h-3 w-3" />
		</button>
	{/if}
{/snippet}

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
				<button
					type="button"
					disabled={operationPending}
					onclick={() => startHunkAction(row.actionTarget, row.view.row.hunkIndex)}
					class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					title={hunkActionTitle()}
				>
					{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus
							class="h-3 w-3"
						/>{/if}
					{activeTab === 'unstaged' ? m.git_action_stage() : m.git_action_unstage()}
				</button>
			</div>
		{:else}
			<div
				data-git-diff-review-row
				class="diff-review-row group/diff-cell relative grid select-none grid-cols-[2rem_3rem_3rem_minmax(0,1fr)] {row
					.view.bgClass}"
			>
				<div class="flex items-center justify-center border-r border-border/30">
					{#if row.view.row.kind === 'add' || row.view.row.kind === 'del'}
						<button
							type="button"
							disabled={operationPending}
							onclick={(event) => {
								event.stopPropagation();
								startLineAction(row.actionTarget, row.view.row.diffLineIndex);
							}}
							class="rounded p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
							title={lineActionTitle()}
							aria-label={lineActionTitle()}
						>
							{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus
									class="h-3 w-3"
								/>{/if}
						</button>
					{/if}
				</div>
				<button
					type="button"
					class="cursor-pointer select-none border-r border-border/30 pr-2 text-right {row.view
						.lineNumClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
					onclick={(event) =>
						handleReviewClick(
							event,
							row.file.path,
							unifiedReviewTarget(row.view),
							row.view.selectionKey,
							row.selectableLineKeys,
						)}
					ondblclick={() => openEditor(row.file.path, row.view.row.beforeLine)}
					title={m.git_comment_add()}
					aria-label={m.git_comment_add()}
				>
					{row.view.row.beforeLine ?? ''}
				</button>
				<button
					type="button"
					class="cursor-pointer select-none border-r border-border/30 pr-2 text-right {row.view
						.lineNumClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
					onclick={(event) =>
						handleReviewClick(
							event,
							row.file.path,
							unifiedReviewTarget(row.view),
							row.view.selectionKey,
							row.selectableLineKeys,
						)}
					ondblclick={() => openEditor(row.file.path, row.view.row.afterLine)}
					title={m.git_comment_add()}
					aria-label={m.git_comment_add()}
				>
					{row.view.row.afterLine ?? ''}
				</button>
				<button
					type="button"
					class="cursor-pointer whitespace-pre-wrap break-all pl-2 pr-8 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
					title={m.git_comment_add()}
					aria-label={m.git_comment_add()}
					onclick={(event) =>
						handleReviewClick(
							event,
							row.file.path,
							unifiedReviewTarget(row.view),
							row.view.selectionKey,
							row.selectableLineKeys,
						)}
				>
					<span class="{row.view.textClass} select-text">{row.view.textPrefix}{row.view.text}</span>
				</button>
				{@render reviewAffordance(row.file.path, unifiedReviewTarget(row.view))}
			</div>
		{/if}
		<GitVirtualCommentThread
			comments={row.view.comments}
			{editingCommentId}
			{editBody}
			{onStartEdit}
			{onCancelEdit}
			{onEditBodyChange}
			{onSaveEdit}
			{onRemoveComment}
		/>
		{#if row.view.showComposer && composerState.open}
			<GitVirtualCommentComposer
				body={composerState.body}
				severity={composerState.severity}
				onBodyChange={onComposerBodyChange}
				onSeverityChange={onComposerSeverityChange}
				onSubmit={onComposerSubmit}
				onClose={onComposerClose}
			/>
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
					{row.view.row.headerText}
				</span>
				<button
					type="button"
					disabled={operationPending}
					onclick={() => startHunkAction(row.actionTarget, row.view.row.hunkIndex ?? -1)}
					class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					title={hunkActionTitle()}
				>
					{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus
							class="h-3 w-3"
						/>{/if}
					{activeTab === 'unstaged' ? m.git_action_stage() : m.git_action_unstage()}
				</button>
			</div>
		{:else}
			<div
				data-git-diff-review-row
				class="diff-review-row grid grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)]"
			>
				{#each splitCellViews(row.view) as cellView, index}
					<div
						class="group/diff-cell grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] {cellView?.bgClass ??
							''}"
					>
						<button
							type="button"
							disabled={!cellView || cellView.cell.kind === 'empty'}
							class="cursor-pointer select-none border-r border-border/30 pr-2 text-right {cellView?.lineNumClass ??
								'text-muted-foreground/30'} disabled:cursor-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
							onclick={(event) =>
								handleReviewClick(
									event,
									row.file.path,
									splitReviewTarget(cellView),
									cellView?.selectionKey ?? null,
									row.selectableLineKeys,
								)}
							ondblclick={() =>
								openEditor(row.file.path, cellView?.side === 'after' ? cellView.cell.line : null)}
							title={cellView && cellView.cell.kind !== 'empty' ? m.git_comment_add() : undefined}
							aria-label={cellView && cellView.cell.kind !== 'empty'
								? m.git_comment_add()
								: undefined}
						>
							{cellView?.cell.line ?? ''}
						</button>
						<div
							class="relative min-w-0 border-r border-border/30"
							class:opacity-40={!cellView || cellView.cell.kind === 'empty'}
						>
							{#if cellView && cellView.cell.kind !== 'empty'}
								<button
									type="button"
									class="block min-h-full w-full cursor-pointer whitespace-pre-wrap break-all py-0 pr-8 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent {cellView
										.cell.kind === 'add' || cellView.cell.kind === 'del'
										? 'pl-7'
										: 'pl-2'}"
									title={m.git_comment_add()}
									aria-label={m.git_comment_add()}
									onclick={(event) =>
										handleReviewClick(
											event,
											row.file.path,
											cellView.contextTarget,
											cellView.selectionKey,
											row.selectableLineKeys,
										)}
								>
									<span class="{cellView.textClass} select-text"
										>{cellView.textPrefix}{cellView.cell.text}</span
									>
								</button>
								{#if cellView.cell.kind === 'add' || cellView.cell.kind === 'del'}
									<button
										type="button"
										disabled={operationPending}
										class="absolute left-1 top-1/2 z-10 -translate-y-1/2 rounded p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
										title={lineActionTitle()}
										aria-label={lineActionTitle()}
										onclick={() => startLineAction(row.actionTarget, cellView.cell.diffLineIndex)}
									>
										{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus
												class="h-3 w-3"
											/>{/if}
									</button>
								{/if}
								{@render reviewAffordance(row.file.path, cellView.contextTarget)}
							{/if}
						</div>
					</div>
					{#if index === 0}
						<div class="bg-border/40 p-0"></div>
					{/if}
				{/each}
			</div>
		{/if}
		<GitVirtualCommentThread
			comments={row.view.comments}
			{editingCommentId}
			{editBody}
			{onStartEdit}
			{onCancelEdit}
			{onEditBodyChange}
			{onSaveEdit}
			{onRemoveComment}
		/>
		{#if row.view.showComposer && composerState.open}
			<GitVirtualCommentComposer
				body={composerState.body}
				severity={composerState.severity}
				onBodyChange={onComposerBodyChange}
				onSeverityChange={onComposerSeverityChange}
				onSubmit={onComposerSubmit}
				onClose={onComposerClose}
			/>
		{/if}
	</div>
{/if}

<style>
	.diff-review-row {
		transition: box-shadow 120ms ease;
	}

	.diff-review-row:hover,
	.diff-review-row:focus-within {
		box-shadow: inset 0 0 0 1px hsl(var(--interactive-accent) / 0.65);
	}
</style>
