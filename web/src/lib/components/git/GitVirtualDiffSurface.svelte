<script lang="ts">
	import type { GitDiffTab, GitReviewCommentDraft } from '$lib/api/git.js';
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { GitDiffActionTarget } from '$lib/git/workbench/git-workbench-types.js';
	import type { CommentComposerState } from '$lib/git/review/git-review-drafts.svelte.js';
	import GitVirtualDiffRow from './GitVirtualDiffRow.svelte';
	import GitVirtualDiffViewport from './GitVirtualDiffViewport.svelte';
	import GitVirtualFileHeader from './GitVirtualFileHeader.svelte';
	import GitVirtualPlaceholderRow from './GitVirtualPlaceholderRow.svelte';
	import type { GitDiffRowInteraction } from './git-diff-row-interaction.js';

	interface GitVirtualDiffSurfaceProps {
		documentId?: string | null;
		rows: GitVirtualReviewRow[];
		fileRowIndex: Map<string, number>;
		activeTab: GitDiffTab;
		fontSize: number;
		selectedLineKeys: Set<string>;
		operationPending: boolean;
		scrollToRequest: { filePath: string; token: number } | null;
		composerState: CommentComposerState;
		showInlineCommentComposer: boolean;
		overscan?: number;
		onVisibleRowsChange: (rows: GitVirtualReviewRow[]) => void;
		onSelectFile: (filePath: string) => void;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onStageFile: (filePath: string) => void;
		onUnstageFile: (filePath: string) => void;
		onAddCommentForFile: (filePath: string, side: 'before' | 'after', line: number) => void;
		onEditComment?: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment?: (id: string) => void;
		commentFeedback?: {
			filePath: string;
			side: 'before' | 'after';
			line: number;
			message: string;
		} | null;
		commentError?: string | null;
		commentCopyText?: string | null;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onComposerFocusHandled?: () => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
		onOpenChat?: () => void;
	}

	let {
		documentId = null,
		rows,
		fileRowIndex,
		activeTab,
		fontSize,
		selectedLineKeys,
		operationPending,
		scrollToRequest,
		composerState,
		showInlineCommentComposer,
		overscan = 18,
		onVisibleRowsChange,
		onSelectFile,
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onStageFile,
		onUnstageFile,
		onAddCommentForFile,
		onEditComment,
		onRemoveComment,
		commentFeedback = null,
		commentError = null,
		commentCopyText = null,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onComposerFocusHandled,
		onOpenInEditor,
		onOpenChat = () => undefined,
	}: GitVirtualDiffSurfaceProps = $props();

	let editingCommentId = $state<string | null>(null);
	let editBody = $state('');

	function startEditComment(comment: GitReviewCommentDraft): void {
		editingCommentId = comment.id;
		editBody = comment.body;
	}

	function cancelEditComment(): void {
		editingCommentId = null;
		editBody = '';
	}

	function saveEditComment(commentId: string): void {
		onEditComment?.(commentId, { body: editBody });
		cancelEditComment();
	}

	let rowInteraction = $derived.by<GitDiffRowInteraction>(() => ({
		kind: 'workbench',
		showInlineCommentComposer,
		activeTab,
		selectedLineKeys,
		operationPending,
		composerState,
		commentFeedback,
		commentError,
		commentCopyText,
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onAddComment: onAddCommentForFile,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onComposerFocusHandled,
		onOpenChat,
		...(onEditComment
			? {
					aggregateReview: {
						editingCommentId,
						editBody,
						onStartEdit: startEditComment,
						onCancelEdit: cancelEditComment,
						onEditBodyChange: (body: string) => {
							editBody = body;
						},
						onSaveEdit: saveEditComment,
						onRemoveComment,
					},
				}
			: {}),
	}));
</script>

{#snippet renderWorkbenchRow(row: GitVirtualReviewRow)}
	{#if row.kind === 'file-header'}
		<GitVirtualFileHeader
			{row}
			{activeTab}
			{operationPending}
			{onSelectFile}
			{onStageFile}
			{onUnstageFile}
		/>
	{:else if row.kind === 'file-placeholder' || row.kind === 'file-limit' || row.kind === 'collection-limit'}
		<GitVirtualPlaceholderRow {row} />
	{:else}
		<GitVirtualDiffRow {row} {fontSize} interaction={rowInteraction} {onOpenInEditor} />
	{/if}
{/snippet}

<GitVirtualDiffViewport
	{documentId}
	{rows}
	{fileRowIndex}
	{fontSize}
	{scrollToRequest}
	{overscan}
	{onVisibleRowsChange}
	rowSnippet={renderWorkbenchRow}
/>
