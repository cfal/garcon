<script lang="ts">
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { CommentComposerState } from '$lib/git/review/git-review-drafts.svelte.js';
	import type { GitReviewCommentDraft } from '$lib/api/git.js';
	import GitVirtualDiffRow from './GitVirtualDiffRow.svelte';
	import GitCommitVirtualFileHeader from './GitCommitVirtualFileHeader.svelte';
	import GitVirtualDiffViewport from './GitVirtualDiffViewport.svelte';
	import GitVirtualPlaceholderRow from './GitVirtualPlaceholderRow.svelte';
	import type { GitDiffRowInteraction } from './git-diff-row-interaction.js';

	interface GitCommitVirtualDiffSurfaceProps {
		documentId: string | null;
		rows: GitVirtualReviewRow[];
		fileRowIndex: Map<string, number>;
		fontSize: number;
		scrollToRequest: { filePath: string; token: number } | null;
		overscan?: number;
		onVisibleRowsChange: (rows: GitVirtualReviewRow[]) => void;
		onSelectFile: (filePath: string) => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
		composerState: CommentComposerState;
		commentFeedback: {
			filePath: string;
			side: 'before' | 'after';
			line: number;
			message: string;
		} | null;
		commentError: string | null;
		commentCopyText: string | null;
		onAddComment: (filePath: string, side: 'before' | 'after', line: number) => void;
		onComposerBodyChange: (body: string) => void;
		onComposerSeverityChange: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit: () => void;
		onComposerClose: () => void;
		onComposerFocusHandled: () => void;
		onOpenChat: () => void;
		emptyMessage: string;
	}

	let {
		documentId,
		rows,
		fileRowIndex,
		fontSize,
		scrollToRequest,
		overscan = 18,
		onVisibleRowsChange,
		onSelectFile,
		onOpenInEditor,
		composerState,
		commentFeedback,
		commentError,
		commentCopyText,
		onAddComment,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onComposerFocusHandled,
		onOpenChat,
		emptyMessage,
	}: GitCommitVirtualDiffSurfaceProps = $props();

	let rowInteraction = $derived.by<GitDiffRowInteraction>(() => ({
		kind: 'commentable',
		composerState,
		commentFeedback,
		commentError,
		commentCopyText,
		onAddComment,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onComposerFocusHandled,
		onOpenChat,
	}));
</script>

{#snippet renderCommitRow(row: GitVirtualReviewRow)}
	{#if row.kind === 'file-header'}
		<GitCommitVirtualFileHeader {row} {onSelectFile} />
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
	{emptyMessage}
	{onVisibleRowsChange}
	rowSnippet={renderCommitRow}
/>
