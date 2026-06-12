<script lang="ts">
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import type { GitDiffTab, GitReviewCommentDraft } from '$lib/api/git.js';
	import type { GitDiffActionTarget } from '$lib/stores/git-workbench.svelte.js';
	import GitDiffCommentComposer from './GitDiffCommentComposer.svelte';
	import GitDiffCommentThread from './GitDiffCommentThread.svelte';
	import type {
		GitDiffComposerDraft,
		GitDiffLineContextTarget,
		SplitDiffCellView,
		SplitDiffRowView,
	} from './git-diff-rows';
	import * as m from '$lib/paraglide/messages.js';

	interface SplitDiffTableProps {
		rows: SplitDiffRowView[];
		activeTab: GitDiffTab;
		actionTarget: GitDiffActionTarget;
		readOnly: boolean;
		headerFontSize: number;
		colCount: number;
		composer: GitDiffComposerDraft | null;
		showLineActions: boolean;
		onCellClick: (event: MouseEvent | KeyboardEvent, cell: SplitDiffCellView) => void;
		onCellKeydown: (event: KeyboardEvent, cell: SplitDiffCellView) => void;
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
		colCount,
		composer,
		showLineActions,
		onCellClick,
		onCellKeydown,
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
	}: SplitDiffTableProps = $props();

	function openRowContextMenu(event: MouseEvent, diffRow: SplitDiffRowView): void {
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const isRight = event.clientX > rect.left + rect.width / 2;
		onOpenContextMenu(
			event,
			(isRight ? diffRow.right?.contextTarget : diffRow.left?.contextTarget) ?? null,
		);
	}
</script>

<table class="w-full border-collapse">
	<tbody>
		{#each rows as diffRow (diffRow.key)}
			{#if diffRow.isHunkHeader}
				<tr class="bg-diff-hunk-header">
					<td colspan={colCount} class="px-2 py-1 text-muted-foreground">
						<div class="flex items-center gap-2" style:font-size={`${headerFontSize}px`}>
							<span class="flex-1 truncate">{diffRow.row.headerText}</span>
							{#if !readOnly}
								{#if activeTab === 'unstaged'}
									<button
										type="button"
										onclick={() => onStageHunk(actionTarget, diffRow.row.hunkIndex ?? -1)}
										class="px-1.5 py-0.5 text-[10px] rounded bg-git-added/20 text-git-added hover:bg-git-added/30 transition-colors"
										title={m.git_action_stage_hunk()}
									>
										<Plus class="w-3 h-3 inline" /> Stage
									</button>
								{:else}
									<button
										type="button"
										onclick={() => onUnstageHunk(actionTarget, diffRow.row.hunkIndex ?? -1)}
										class="px-1.5 py-0.5 text-[10px] rounded bg-git-deleted/20 text-git-deleted hover:bg-git-deleted/30 transition-colors"
										title={m.git_action_unstage_hunk()}
									>
										<Minus class="w-3 h-3 inline" /> Unstage
									</button>
								{/if}
							{/if}
						</div>
					</td>
				</tr>
			{:else}
				<tr class="select-none" oncontextmenu={(event) => openRowContextMenu(event, diffRow)}>
					{#if showLineActions}
						<td
							class="w-7 select-none border-r border-border/30 p-0 {diffRow.left?.bgClass ?? ''}"
						>
							<div class="flex items-center justify-center leading-5">
								{#if diffRow.left?.cell.kind === 'del'}
									{#if activeTab === 'unstaged'}
										<button
											type="button"
											onclick={(event) => {
												event.stopPropagation();
												onStageLine?.(actionTarget, diffRow.left!.cell.diffLineIndex);
											}}
											class="flex items-center justify-center text-muted-foreground/30 hover:text-git-added hover:bg-git-added/20 transition-colors rounded p-0.5"
											title={m.git_action_stage_line()}
										>
											<Plus class="w-2.5 h-2.5" />
										</button>
									{:else}
										<button
											type="button"
											onclick={(event) => {
												event.stopPropagation();
												onUnstageLine?.(actionTarget, diffRow.left!.cell.diffLineIndex);
											}}
											class="flex items-center justify-center text-muted-foreground/30 hover:text-git-deleted hover:bg-git-deleted/20 transition-colors rounded p-0.5"
											title={m.git_action_unstage_line()}
										>
											<Minus class="w-2.5 h-2.5" />
										</button>
									{/if}
								{/if}
							</div>
						</td>
					{/if}
					<td
						class="w-10 text-right pr-1.5 select-none {diffRow.left?.lineNumClass ??
							''} border-r border-border/30 {diffRow.left?.bgClass ?? ''} {diffRow.left
							?.contextTarget
							? 'cursor-pointer hover:bg-interactive-accent/10'
							: ''}"
						onclick={(event) => {
							if (!diffRow.left?.contextTarget) return;
							onOpenContextMenu(event, diffRow.left.contextTarget);
						}}
					>
						{diffRow.left?.cell.line ?? ''}
					</td>
					<td
						class="w-1/2 pl-2 pr-1 whitespace-pre-wrap break-all {diffRow.left?.isSelectable
							? 'cursor-pointer'
							: ''} {diffRow.left?.bgClass ?? ''}"
						tabindex={diffRow.left?.isSelectable ? 0 : -1}
						role={diffRow.left?.isSelectable ? 'button' : undefined}
						onclick={(event) => {
							if (diffRow.left?.isSelectable) onCellClick(event, diffRow.left);
						}}
						onkeydown={(event) => {
							if (diffRow.left?.isSelectable) onCellKeydown(event, diffRow.left);
						}}
					>
						{#if diffRow.left && diffRow.left.cell.kind !== 'empty'}
							<span class="{diffRow.left.textClass} select-text"
								>{diffRow.left.textPrefix}{diffRow.left.cell.text}</span
							>
						{:else}
							&nbsp;
						{/if}
					</td>
					{#if showLineActions}
						<td
							class="w-7 select-none border-l border-r border-border/30 p-0 {diffRow.right?.bgClass ??
								''}"
						>
							<div class="flex items-center justify-center leading-5">
								{#if diffRow.right?.cell.kind === 'add'}
									{#if activeTab === 'unstaged'}
										<button
											type="button"
											onclick={(event) => {
												event.stopPropagation();
												onStageLine?.(actionTarget, diffRow.right!.cell.diffLineIndex);
											}}
											class="flex items-center justify-center text-muted-foreground/30 hover:text-git-added hover:bg-git-added/20 transition-colors rounded p-0.5"
											title={m.git_action_stage_line()}
										>
											<Plus class="w-2.5 h-2.5" />
										</button>
									{:else}
										<button
											type="button"
											onclick={(event) => {
												event.stopPropagation();
												onUnstageLine?.(actionTarget, diffRow.right!.cell.diffLineIndex);
											}}
											class="flex items-center justify-center text-muted-foreground/30 hover:text-git-deleted hover:bg-git-deleted/20 transition-colors rounded p-0.5"
											title={m.git_action_unstage_line()}
										>
											<Minus class="w-2.5 h-2.5" />
										</button>
									{/if}
								{/if}
							</div>
						</td>
					{/if}
					<td
						class="w-10 text-right pr-1.5 select-none {diffRow.right?.lineNumClass ??
							''} border-l border-r border-border/30 {diffRow.right?.bgClass ?? ''} {diffRow
							.right?.contextTarget
							? 'cursor-pointer hover:bg-interactive-accent/10'
							: ''}"
						onclick={(event) => {
							if (!diffRow.right?.contextTarget) return;
							onOpenContextMenu(event, diffRow.right.contextTarget);
						}}
					>
						{diffRow.right?.cell.line ?? ''}
					</td>
					<td
						class="w-1/2 pl-2 pr-1 whitespace-pre-wrap break-all {diffRow.right?.isSelectable
							? 'cursor-pointer'
							: ''} {diffRow.right?.bgClass ?? ''}"
						tabindex={diffRow.right?.isSelectable ? 0 : -1}
						role={diffRow.right?.isSelectable ? 'button' : undefined}
						onclick={(event) => {
							if (diffRow.right?.isSelectable) onCellClick(event, diffRow.right);
						}}
						onkeydown={(event) => {
							if (diffRow.right?.isSelectable) onCellKeydown(event, diffRow.right);
						}}
					>
						{#if diffRow.right && diffRow.right.cell.kind !== 'empty'}
							<span class="{diffRow.right.textClass} select-text"
								>{diffRow.right.textPrefix}{diffRow.right.cell.text}</span
							>
						{:else}
							&nbsp;
						{/if}
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
		{/each}
	</tbody>
</table>
