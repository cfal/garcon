<script lang="ts">
	import type { GitDiffTab, GitReviewCommentDraft } from '$lib/api/git.js';
	import type {
		GitDiffActionTarget,
		GitVirtualReviewRow,
	} from '$lib/stores/git-workbench.svelte.js';
	import type { CommentComposerState } from '$lib/stores/git/git-review-drafts.svelte';
	import GitVirtualDiffRow from './GitVirtualDiffRow.svelte';
	import GitVirtualDiffViewport from './GitVirtualDiffViewport.svelte';
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
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onStageFile: (filePath: string) => void;
		onUnstageFile: (filePath: string) => void;
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
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onOpenInEditor,
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
		onEditComment(commentId, { body: editBody });
		cancelEditComment();
	}
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
{/snippet}

<GitVirtualDiffViewport
	{rows}
	{fileRowIndex}
	{fontSize}
	{scrollToRequest}
	{overscan}
	{onVisibleRowsChange}
	rowSnippet={renderWorkbenchRow}
/>
