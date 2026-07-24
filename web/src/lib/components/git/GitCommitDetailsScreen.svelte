<script lang="ts">
	import type { GitCommitFileSummary, GitCommitSnapshotReady } from '$lib/api/git.js';
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type {
		CommentComposerState,
		GitDiffSeverity,
	} from '$lib/git/review/git-inline-comment.svelte.js';
	import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
	import GitCommitDetailsHeader from './GitCommitDetailsHeader.svelte';
	import GitDiffDocumentScreen from './GitDiffDocumentScreen.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface GitCommitDetailsScreenProps {
		snapshot: GitCommitSnapshotReady | null;
		files: GitCommitFileSummary[];
		isLoading: boolean;
		error: string | null;
		rows: GitVirtualReviewRow[];
		fileRowIndex: Map<string, number>;
		scrollRequest: { filePath: string; token: number } | null;
		fileFilter: string;
		focusedFilePath: string | null;
		isMobile: boolean;
		fontSize: number;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: string;
		onBack: () => void;
		onRetry: () => void;
		onSelectParent: (parent: string | null) => void;
		onRevertCommit: () => void;
		onCompare: () => void;
		onSetDiffMode: (mode: DiffMode) => void;
		onSetContextLines: (lines: number) => void;
		onSetDiffFontSize: (size: string) => void;
		onSelectFile: (file: string) => void;
		onFileFilterChange: (value: string) => void;
		onVisibleRowsChange: (rows: GitVirtualReviewRow[]) => void;
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
		onComposerSeverityChange: (severity: GitDiffSeverity) => void;
		onComposerSubmit: () => void;
		onComposerClose: () => void;
		onComposerFocusHandled: () => void;
		onOpenChat: () => void;
	}

	let props: GitCommitDetailsScreenProps = $props();
</script>

{#snippet header(
	showFileTreeToggle: boolean,
	fileTreeVisible: boolean,
	onToggleFileTree: () => void,
)}
	{#if props.snapshot}
		<GitCommitDetailsHeader
			snapshot={props.snapshot}
			onBack={props.onBack}
			onSelectParent={props.onSelectParent}
			onRevertCommit={props.onRevertCommit}
			onCompare={props.onCompare}
			diffMode={props.diffMode}
			contextLines={props.contextLines}
			diffFontSize={props.diffFontSize}
			onSetDiffMode={props.onSetDiffMode}
			onSetContextLines={props.onSetContextLines}
			onSetDiffFontSize={props.onSetDiffFontSize}
			{showFileTreeToggle}
			{fileTreeVisible}
			{onToggleFileTree}
		/>
	{/if}
{/snippet}

<GitDiffDocumentScreen
	{header}
	documentId={props.snapshot?.documentId ?? null}
	documentAvailable={Boolean(props.snapshot)}
	files={props.files}
	isLoading={props.isLoading}
	error={props.error}
	rows={props.rows}
	fileRowIndex={props.fileRowIndex}
	scrollRequest={props.scrollRequest}
	fileFilter={props.fileFilter}
	focusedFilePath={props.focusedFilePath}
	isMobile={props.isMobile}
	fontSize={props.fontSize}
	loadingLabel={m.git_commit_details_loading()}
	emptyErrorLabel={m.git_commit_not_found()}
	emptyDocumentLabel={m.git_commit_no_changes()}
	onBack={props.onBack}
	onRetry={props.onRetry}
	onSelectFile={props.onSelectFile}
	onFileFilterChange={props.onFileFilterChange}
	onVisibleRowsChange={props.onVisibleRowsChange}
	onOpenInEditor={props.onOpenInEditor}
	composerState={props.composerState}
	commentFeedback={props.commentFeedback}
	commentError={props.commentError}
	commentCopyText={props.commentCopyText}
	onAddComment={props.onAddComment}
	onComposerBodyChange={props.onComposerBodyChange}
	onComposerSeverityChange={props.onComposerSeverityChange}
	onComposerSubmit={props.onComposerSubmit}
	onComposerClose={props.onComposerClose}
	onComposerFocusHandled={props.onComposerFocusHandled}
	onOpenChat={props.onOpenChat}
/>
