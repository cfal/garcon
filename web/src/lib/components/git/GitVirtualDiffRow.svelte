<script lang="ts">
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import type { GitDiffTab, GitReviewCommentDraft } from '$lib/api/git.js';
	import type { CommentComposerState } from '$lib/stores/git/git-review-drafts.svelte';
	import type {
		GitDiffActionTarget,
		GitVirtualReviewRow,
	} from '$lib/stores/git-workbench.svelte.js';
	import type { SplitDiffCellView, SplitDiffRowView, UnifiedDiffRowView } from './git-diff-rows';
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

	function handleLineClick(
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

	function handleLineKeydown(
		event: KeyboardEvent,
		selectionKey: string | null,
		selectableLineKeys: string[],
	): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		handleLineClick(event, selectionKey, selectableLineKeys);
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

	function addCommentForUnified(filePath: string, view: UnifiedDiffRowView): void {
		const target = view.row.kind === 'del' ? view.beforeContextTarget : view.afterContextTarget;
		if (!target) return;
		onAddCommentForFile(filePath, target.side, target.line);
	}

	function addCommentForSplit(filePath: string, cellView: SplitDiffCellView | null): void {
		const target = cellView?.contextTarget;
		if (!target) return;
		onAddCommentForFile(filePath, target.side, target.line);
	}

	function openEditor(filePath: string, line: number | null): void {
		if (line === null) return;
		onOpenInEditor?.(filePath, line);
	}

	function splitCellViews(view: SplitDiffRowView): [SplitDiffCellView | null, SplitDiffCellView | null] {
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
				<button
					type="button"
					disabled={operationPending}
					onclick={() => startHunkAction(row.actionTarget, row.view.row.hunkIndex)}
					class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					title={hunkActionTitle()}
				>
					{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus class="h-3 w-3" />{/if}
					{activeTab === 'unstaged' ? m.git_action_stage() : m.git_action_unstage()}
				</button>
			</div>
		{:else}
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (Selectable diff rows cannot be buttons because they contain nested staging and comment buttons.) -->
			<div
				class="grid select-none grid-cols-[2rem_3rem_3rem_minmax(0,1fr)_2rem] {row.view.bgClass} {row.view.isSelectable
					? 'cursor-pointer hover:brightness-95'
					: ''}"
				tabindex={row.view.isSelectable ? 0 : -1}
				role={row.view.isSelectable ? 'button' : undefined}
				onclick={(event) => handleLineClick(event, row.view.selectionKey, row.selectableLineKeys)}
				onkeydown={(event) => handleLineKeydown(event, row.view.selectionKey, row.selectableLineKeys)}
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
							{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus class="h-3 w-3" />{/if}
						</button>
					{/if}
				</div>
				<button
					type="button"
					class="select-none border-r border-border/30 pr-2 text-right {row.view.lineNumClass}"
					ondblclick={() => openEditor(row.file.path, row.view.row.beforeLine)}
					title="Open before line in editor"
				>
					{row.view.row.beforeLine ?? ''}
				</button>
				<button
					type="button"
					class="select-none border-r border-border/30 pr-2 text-right {row.view.lineNumClass}"
					ondblclick={() => openEditor(row.file.path, row.view.row.afterLine)}
					title="Open after line in editor"
				>
					{row.view.row.afterLine ?? ''}
				</button>
				<div class="whitespace-pre-wrap break-all pl-2 pr-3">
					<span class="{row.view.textClass} select-text">{row.view.textPrefix}{row.view.text}</span>
				</div>
				<div class="pr-1 text-right">
					<button
						type="button"
						class="rounded p-0.5 text-muted-foreground/35 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						title={m.git_comment_add()}
						aria-label={m.git_comment_add()}
						onclick={(event) => {
							event.stopPropagation();
							addCommentForUnified(row.file.path, row.view);
						}}
					>
						<MessageSquarePlus class="h-3 w-3" />
					</button>
				</div>
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
					{#if activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus class="h-3 w-3" />{/if}
					{activeTab === 'unstaged' ? m.git_action_stage() : m.git_action_unstage()}
				</button>
			</div>
		{:else}
			<div class="grid grid-cols-[3rem_minmax(0,1fr)_1px_3rem_minmax(0,1fr)]">
				{#each splitCellViews(row.view) as cellView, index}
					<button
						type="button"
						class="select-none border-r border-border/30 pr-2 text-right {cellView?.lineNumClass ?? 'text-muted-foreground/30'} {cellView?.bgClass ?? ''}"
						ondblclick={() => openEditor(row.file.path, cellView?.side === 'after' ? cellView.cell.line : null)}
						title="Open after line in editor"
					>
						{cellView?.cell.line ?? ''}
					</button>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (Selectable split diff cells cannot be buttons because they contain nested staging and comment buttons.) -->
					<div
						class="border-r border-border/30 pl-2 pr-2 whitespace-pre-wrap break-all {cellView?.bgClass ?? ''} {cellView?.isSelectable
							? 'cursor-pointer hover:brightness-95'
							: ''}"
						class:opacity-40={!cellView || cellView.cell.kind === 'empty'}
						tabindex={cellView?.isSelectable ? 0 : -1}
						role={cellView?.isSelectable ? 'button' : undefined}
						onclick={(event) => handleLineClick(event, cellView?.selectionKey ?? null, row.selectableLineKeys)}
						onkeydown={(event) => handleLineKeydown(event, cellView?.selectionKey ?? null, row.selectableLineKeys)}
					>
						{#if cellView && cellView.cell.kind !== 'empty'}
							<button
								type="button"
								class="mr-1 rounded p-0.5 text-muted-foreground/35 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								title={m.git_comment_add()}
								aria-label={m.git_comment_add()}
								onclick={(event) => {
									event.stopPropagation();
									addCommentForSplit(row.file.path, cellView);
								}}
							>
								<MessageSquarePlus class="inline h-3 w-3" />
							</button>
							{#if cellView.cell.kind === 'add' || cellView.cell.kind === 'del'}
								<button
									type="button"
									disabled={operationPending}
									class="mr-1 rounded p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
									title={lineActionTitle()}
									aria-label={lineActionTitle()}
									onclick={(event) => {
										event.stopPropagation();
										startLineAction(row.actionTarget, cellView.cell.diffLineIndex);
									}}
								>
									{#if activeTab === 'unstaged'}<Plus class="inline h-3 w-3" />{:else}<Minus class="inline h-3 w-3" />{/if}
								</button>
							{/if}
							<span class="{cellView.textClass} select-text">{cellView.textPrefix}{cellView.cell.text}</span>
						{/if}
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
