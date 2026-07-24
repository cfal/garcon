<script lang="ts">
	import type { GitDiffTab } from '$lib/api/git.js';
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { GitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
	import type { GitDiffActionTarget } from '$lib/git/workbench/git-workbench-types.js';
	import type {
		CommentComposerState,
		GitDiffSeverity,
	} from '$lib/git/review/git-inline-comment.svelte.js';
	import GitVirtualDiffRow from './GitVirtualDiffRow.svelte';
	import GitVirtualDiffViewport from './GitVirtualDiffViewport.svelte';
	import GitVirtualFileHeader from './GitVirtualFileHeader.svelte';
	import GitVirtualPlaceholderRow from './GitVirtualPlaceholderRow.svelte';
	import type { GitDiffRowInteraction } from './git-diff-row-interaction.js';

	interface GitVirtualDiffSurfaceProps {
		documentId: string | null;
		source: GitVirtualReviewRowSource;
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
		commentFeedback: {
			filePath: string;
			side: 'before' | 'after';
			line: number;
			message: string;
		} | null;
		commentError: string | null;
		commentCopyText: string | null;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: GitDiffSeverity) => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onComposerFocusHandled?: () => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
		onOpenChat: () => void;
	}

	let {
		documentId,
		source,
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
		commentFeedback,
		commentError,
		commentCopyText,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onComposerFocusHandled,
		onOpenInEditor,
		onOpenChat,
	}: GitVirtualDiffSurfaceProps = $props();

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
	{:else if row.kind === 'unified-row' || row.kind === 'split-row'}
		<GitVirtualDiffRow {row} {fontSize} interaction={rowInteraction} {onOpenInEditor} />
	{/if}
{/snippet}

<GitVirtualDiffViewport
	{documentId}
	{source}
	{fontSize}
	{scrollToRequest}
	{overscan}
	{onVisibleRowsChange}
	rowSnippet={renderWorkbenchRow}
/>
