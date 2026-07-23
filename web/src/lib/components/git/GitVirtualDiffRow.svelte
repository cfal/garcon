<script lang="ts">
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { GitDiffActionTarget } from '$lib/git/workbench/git-workbench-types.js';
	import type {
		GitDiffLineContextTarget,
		SplitDiffCellView,
		SplitDiffRowView,
	} from '$lib/git/review/git-diff-rows.js';
	import GitVirtualCommentComposer from './GitVirtualCommentComposer.svelte';
	import GitCommentAppendError from './GitCommentAppendError.svelte';
	import type {
		GitDiffCommentInteraction,
		GitDiffRowInteraction,
		GitDiffWorkbenchInteraction,
	} from './git-diff-row-interaction.js';
	import * as m from '$lib/paraglide/messages.js';

	type DiffContentRow = Extract<GitVirtualReviewRow, { kind: 'unified-row' | 'split-row' }>;

	interface GitVirtualDiffRowProps {
		row: DiffContentRow;
		fontSize: number;
		interaction: GitDiffRowInteraction;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let { row, fontSize, interaction, onOpenInEditor }: GitVirtualDiffRowProps = $props();

	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));
	let headerFontSize = $derived(Math.max(10, Math.round(fontSize * 0.82)));
	let commentControls = $derived(commentInteraction());
	let workbenchControls = $derived(workbenchInteraction());

	function selectLine(
		event: MouseEvent | KeyboardEvent,
		selectionKey: string | null,
		selectableLineKeys: string[],
	): void {
		if (interaction.kind !== 'workbench' || !selectionKey) return;
		if (event.shiftKey && interaction.selectedLineKeys.size > 0) {
			const last = Array.from(interaction.selectedLineKeys).at(-1);
			if (last) interaction.onSelectLineRange(last, selectionKey, selectableLineKeys);
			return;
		}
		interaction.onToggleLineSelection(selectionKey);
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
		if (!target || interaction.kind === 'read-only') return;
		interaction.onAddComment(filePath, target.side, target.line);
	}

	function handleReviewClick(
		event: MouseEvent,
		filePath: string,
		target: GitDiffLineContextTarget | null,
		selectionKey: string | null,
		selectableLineKeys: string[],
	): void {
		if (hasSelectedText(event.currentTarget)) return;
		if (interaction.kind === 'workbench' && usesLineSelectionModifier(event) && selectionKey) {
			selectLine(event, selectionKey, selectableLineKeys);
			return;
		}
		openReview(filePath, target);
	}

	function startHunkAction(actionTarget: GitDiffActionTarget, hunkIndex: number): void {
		if (interaction.kind !== 'workbench') return;
		if (interaction.activeTab === 'unstaged') interaction.onStageHunk(actionTarget, hunkIndex);
		else interaction.onUnstageHunk(actionTarget, hunkIndex);
	}

	function startLineAction(actionTarget: GitDiffActionTarget, diffLineIndex: number): void {
		if (interaction.kind !== 'workbench') return;
		if (interaction.activeTab === 'unstaged') interaction.onStageLine(actionTarget, diffLineIndex);
		else interaction.onUnstageLine(actionTarget, diffLineIndex);
	}

	function lineActionTitle(): string {
		return interaction.kind === 'workbench' && interaction.activeTab === 'unstaged'
			? m.git_action_stage_line()
			: m.git_action_unstage_line();
	}

	function hunkActionTitle(): string {
		return interaction.kind === 'workbench' && interaction.activeTab === 'unstaged'
			? m.git_action_stage_hunk()
			: m.git_action_unstage_hunk();
	}

	function reviewTargetLabel(target: GitDiffLineContextTarget | null): string | undefined {
		if (!target) return undefined;
		return target.side === 'before'
			? m.git_comment_add_old_line_to_chat({ line: target.line })
			: m.git_comment_add_new_line_to_chat({ line: target.line });
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

	function feedbackMatches(target: GitDiffLineContextTarget | null): boolean {
		if (!target || interaction.kind === 'read-only') return false;
		return Boolean(
			interaction.commentFeedback &&
			interaction.commentFeedback.filePath === row.file.path &&
			interaction.commentFeedback.side === target.side &&
			interaction.commentFeedback.line === target.line,
		);
	}

	function commentInteraction(): GitDiffCommentInteraction | null {
		return interaction.kind === 'read-only' ? null : interaction;
	}

	function workbenchInteraction(): GitDiffWorkbenchInteraction | null {
		return interaction.kind === 'workbench' ? interaction : null;
	}
</script>

{#snippet reviewAffordance(filePath: string, target: GitDiffLineContextTarget | null)}
	{#if target && interaction.kind !== 'read-only'}
		<button
			type="button"
			data-git-comment-affordance
			class="absolute right-1 top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center rounded border border-border bg-background/95 p-0.5 text-muted-foreground opacity-100 shadow-sm transition-[color,background-color,opacity] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/diff-cell:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/diff-cell:opacity-100"
			title={m.git_comment_add_to_chat()}
			aria-label={m.git_comment_add_to_chat()}
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
				{#if workbenchControls && row.actionTarget}
					<button
						type="button"
						disabled={workbenchControls.operationPending}
						onclick={() => startHunkAction(row.actionTarget!, row.view.row.hunkIndex)}
						class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						title={hunkActionTitle()}
					>
						{#if workbenchControls.activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus
								class="h-3 w-3"
							/>{/if}
						{workbenchControls.activeTab === 'unstaged'
							? m.git_action_stage()
							: m.git_action_unstage()}
					</button>
				{/if}
			</div>
		{:else}
			{@const defaultTarget = row.view.rowContextTarget}
			<div
				data-git-diff-review-row
				class="diff-review-row group/diff-cell relative grid select-none {workbenchControls
					? 'grid-cols-[2rem_3rem_3rem_minmax(0,1fr)]'
					: 'grid-cols-[3rem_3rem_minmax(0,1fr)]'} {row.view.bgClass}"
			>
				{#if workbenchControls && row.actionTarget}
					<div class="flex items-center justify-center border-r border-border/30">
						{#if row.view.row.kind === 'add' || row.view.row.kind === 'del'}
							<button
								type="button"
								disabled={workbenchControls.operationPending}
								onclick={(event) => {
									event.stopPropagation();
									startLineAction(row.actionTarget!, row.view.row.diffLineIndex);
								}}
								class="rounded p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
								title={lineActionTitle()}
								aria-label={lineActionTitle()}
							>
								{#if workbenchControls.activeTab === 'unstaged'}<Plus
										class="h-3 w-3"
									/>{:else}<Minus class="h-3 w-3" />{/if}
							</button>
						{/if}
					</div>
				{/if}
				{#if row.view.beforeContextTarget && commentControls}
					<button
						type="button"
						class="cursor-pointer select-none border-r border-border/30 pr-2 text-right {row.view
							.lineNumClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
						onclick={(event) =>
							handleReviewClick(
								event,
								row.file.path,
								row.view.beforeContextTarget,
								row.view.selectionKey,
								row.selectableLineKeys,
							)}
						ondblclick={() => openEditor(row.file.path, row.view.row.beforeLine)}
						title={m.git_comment_add_old_line_to_chat({
							line: row.view.beforeContextTarget.line,
						})}
						aria-label={m.git_comment_add_old_line_to_chat({
							line: row.view.beforeContextTarget.line,
						})}
					>
						{row.view.row.beforeLine}
					</button>
				{:else}
					<span
						aria-hidden="true"
						class="select-none border-r border-border/30 pr-2 text-right {row.view.lineNumClass}"
						>{row.view.row.beforeLine ?? ''}</span
					>
				{/if}
				{#if row.view.afterContextTarget && commentControls}
					<button
						type="button"
						class="cursor-pointer select-none border-r border-border/30 pr-2 text-right {row.view
							.lineNumClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
						onclick={(event) =>
							handleReviewClick(
								event,
								row.file.path,
								row.view.afterContextTarget,
								row.view.selectionKey,
								row.selectableLineKeys,
							)}
						ondblclick={() => openEditor(row.file.path, row.view.row.afterLine)}
						title={m.git_comment_add_new_line_to_chat({ line: row.view.afterContextTarget.line })}
						aria-label={m.git_comment_add_new_line_to_chat({
							line: row.view.afterContextTarget.line,
						})}
					>
						{row.view.row.afterLine}
					</button>
				{:else}
					<span
						aria-hidden="true"
						class="select-none border-r border-border/30 pr-2 text-right {row.view.lineNumClass}"
						>{row.view.row.afterLine ?? ''}</span
					>
				{/if}
				{#if defaultTarget && commentControls}
					<button
						type="button"
						class="cursor-pointer whitespace-pre-wrap break-all pl-2 pr-8 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
						title={m.git_comment_add_to_chat()}
						aria-label={m.git_comment_add_to_chat()}
						onclick={(event) =>
							handleReviewClick(
								event,
								row.file.path,
								defaultTarget,
								row.view.selectionKey,
								row.selectableLineKeys,
							)}
					>
						<span class="{row.view.textClass} select-text"
							>{row.view.textPrefix}{row.view.text}</span
						>
					</button>
				{:else}
					<div class="whitespace-pre-wrap break-all pl-2 pr-8 text-left">
						<span class="{row.view.textClass} select-text"
							>{row.view.textPrefix}{row.view.text}</span
						>
					</div>
				{/if}
				{@render reviewAffordance(row.file.path, defaultTarget)}
			</div>
		{/if}
		{#if row.view.showComposer && commentControls?.composerState.open && (interaction.kind !== 'workbench' || interaction.showInlineCommentComposer)}
			<GitVirtualCommentComposer
				body={commentControls.composerState.body}
				severity={commentControls.composerState.severity}
				focusPending={commentControls.composerState.focusPending}
				submitLabel={m.git_comment_add_to_chat()}
				onBodyChange={commentControls.onComposerBodyChange}
				onSeverityChange={commentControls.onComposerSeverityChange}
				onSubmit={commentControls.onComposerSubmit}
				onClose={commentControls.onComposerClose}
				onFocusHandled={commentControls.onComposerFocusHandled}
			/>
			{#if commentControls.commentError}<GitCommentAppendError
					error={commentControls.commentError}
					copyText={commentControls.commentCopyText}
				/>{/if}
		{/if}
		{#if commentControls && (feedbackMatches(row.view.beforeContextTarget) || feedbackMatches(row.view.afterContextTarget))}<div
				class="flex items-center gap-2 border-t border-border bg-interactive-accent/10 px-3 py-1.5 text-xs text-interactive-accent"
				role="status"
			>
				<span class="flex-1">{commentControls.commentFeedback?.message}</span><button
					type="button"
					class="font-medium underline underline-offset-2"
					onclick={commentControls.onOpenChat}>{m.git_comment_open_chat()}</button
				>
			</div>{/if}
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
				{#if workbenchControls && row.actionTarget}
					<button
						type="button"
						disabled={workbenchControls.operationPending}
						onclick={() => startHunkAction(row.actionTarget!, row.view.row.hunkIndex ?? -1)}
						class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						title={hunkActionTitle()}
					>
						{#if workbenchControls.activeTab === 'unstaged'}<Plus class="h-3 w-3" />{:else}<Minus
								class="h-3 w-3"
							/>{/if}
						{workbenchControls.activeTab === 'unstaged'
							? m.git_action_stage()
							: m.git_action_unstage()}
					</button>
				{/if}
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
						{#if cellView?.contextTarget && commentControls}
							<button
								type="button"
								class="cursor-pointer select-none border-r border-border/30 pr-2 text-right {cellView.lineNumClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent"
								onclick={(event) =>
									handleReviewClick(
										event,
										row.file.path,
										cellView.contextTarget,
										cellView.selectionKey,
										row.selectableLineKeys,
									)}
								ondblclick={() =>
									openEditor(row.file.path, cellView.side === 'after' ? cellView.cell.line : null)}
								title={reviewTargetLabel(cellView.contextTarget)}
								aria-label={reviewTargetLabel(cellView.contextTarget)}
							>
								{cellView.cell.line}
							</button>
						{:else}
							<span
								aria-hidden="true"
								class="select-none border-r border-border/30 pr-2 text-right {cellView?.lineNumClass ??
									'text-muted-foreground/30'}">{cellView?.cell.line ?? ''}</span
							>
						{/if}
						<div
							class="relative min-w-0 border-r border-border/30"
							class:opacity-40={!cellView || cellView.cell.kind === 'empty'}
						>
							{#if cellView && cellView.cell.kind !== 'empty'}
								{#if cellView.contextTarget && commentControls}
									<button
										type="button"
										class="block min-h-full w-full cursor-pointer whitespace-pre-wrap break-all py-0 pr-8 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-accent {cellView
											.cell.kind === 'add' || cellView.cell.kind === 'del'
											? 'pl-7'
											: 'pl-2'}"
										title={reviewTargetLabel(cellView.contextTarget)}
										aria-label={reviewTargetLabel(cellView.contextTarget)}
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
								{:else}
									<div
										class="min-h-full whitespace-pre-wrap break-all py-0 pr-8 text-left {cellView
											.cell.kind === 'add' || cellView.cell.kind === 'del'
											? 'pl-7'
											: 'pl-2'}"
									>
										<span class="{cellView.textClass} select-text"
											>{cellView.textPrefix}{cellView.cell.text}</span
										>
									</div>
								{/if}
								{#if workbenchControls && row.actionTarget && (cellView.cell.kind === 'add' || cellView.cell.kind === 'del')}
									<button
										type="button"
										disabled={workbenchControls.operationPending}
										class="absolute left-1 top-1/2 z-10 -translate-y-1/2 rounded p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
										title={lineActionTitle()}
										aria-label={lineActionTitle()}
										onclick={() => startLineAction(row.actionTarget!, cellView.cell.diffLineIndex)}
									>
										{#if workbenchControls.activeTab === 'unstaged'}<Plus
												class="h-3 w-3"
											/>{:else}<Minus class="h-3 w-3" />{/if}
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
		{#if row.view.showComposer && commentControls?.composerState.open && (interaction.kind !== 'workbench' || interaction.showInlineCommentComposer)}
			<GitVirtualCommentComposer
				body={commentControls.composerState.body}
				severity={commentControls.composerState.severity}
				focusPending={commentControls.composerState.focusPending}
				submitLabel={m.git_comment_add_to_chat()}
				onBodyChange={commentControls.onComposerBodyChange}
				onSeverityChange={commentControls.onComposerSeverityChange}
				onSubmit={commentControls.onComposerSubmit}
				onClose={commentControls.onComposerClose}
				onFocusHandled={commentControls.onComposerFocusHandled}
			/>
			{#if commentControls.commentError}<GitCommentAppendError
					error={commentControls.commentError}
					copyText={commentControls.commentCopyText}
				/>{/if}
		{/if}
		{#if commentControls && (feedbackMatches(row.view.left?.contextTarget ?? null) || feedbackMatches(row.view.right?.contextTarget ?? null))}<div
				class="flex items-center gap-2 border-t border-border bg-interactive-accent/10 px-3 py-1.5 text-xs text-interactive-accent"
				role="status"
			>
				<span class="flex-1">{commentControls.commentFeedback?.message}</span><button
					type="button"
					class="font-medium underline underline-offset-2"
					onclick={commentControls.onOpenChat}>{m.git_comment_open_chat()}</button
				>
			</div>{/if}
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
