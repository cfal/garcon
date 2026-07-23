<script lang="ts">
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import type { GitComparisonController } from '$lib/git/review/git-comparison.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
	import GitComparisonHeader from './GitComparisonHeader.svelte';
	import GitDiffDocumentScreen from './GitDiffDocumentScreen.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface GitComparisonScreenProps {
		comparison: GitComparisonController;
		isMobile: boolean;
		fontSize: number;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: string;
		onBack: () => void;
		onRefresh: () => void;
		onSetDiffMode: (mode: DiffMode) => void;
		onSetContextLines: (lines: number) => void;
		onSetDiffFontSize: (size: string) => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
		onAppendToChatDraft?: ChatDraftAppend;
		onOpenChat: () => void;
	}

	let {
		comparison,
		isMobile,
		fontSize,
		diffMode,
		contextLines,
		diffFontSize,
		onBack,
		onRefresh,
		onSetDiffMode,
		onSetContextLines,
		onSetDiffFontSize,
		onOpenInEditor,
		onAppendToChatDraft,
		onOpenChat,
	}: GitComparisonScreenProps = $props();
</script>

{#snippet header(
	showFileTreeToggle: boolean,
	fileTreeVisible: boolean,
	onToggleFileTree: () => void,
)}
	{#if comparison.snapshot}
		<GitComparisonHeader
			snapshot={comparison.snapshot}
			isRefreshing={comparison.isLoading}
			{diffMode}
			{contextLines}
			{diffFontSize}
			{onBack}
			onEdit={() => comparison.editComparison()}
			{onRefresh}
			{onSetDiffMode}
			{onSetContextLines}
			{onSetDiffFontSize}
			{showFileTreeToggle}
			{fileTreeVisible}
			{onToggleFileTree}
		/>
		{#if comparison.staleMessage}
			<div
				class="flex items-center gap-2 border-b border-status-warning-border bg-status-warning/10 px-3 py-2 text-xs text-status-warning-muted-foreground"
				role="status"
			>
				<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
				<span class="min-w-0 flex-1">{comparison.staleMessage}</span>
				<button
					type="button"
					class="rounded border border-status-warning-border px-2 py-1 font-medium hover:bg-status-warning/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					disabled={comparison.isLoading}
					onclick={onRefresh}>{m.git_compare_refresh()}</button
				>
			</div>
		{/if}
	{/if}
{/snippet}

<GitDiffDocumentScreen
	{header}
	documentId={comparison.snapshot?.documentId ?? null}
	documentAvailable={Boolean(comparison.snapshot)}
	files={comparison.document.visibleFiles}
	isLoading={comparison.isLoading}
	error={comparison.documentError}
	onDismissError={() => comparison.dismissDocumentError()}
	rows={comparison.document.virtualRows}
	fileRowIndex={comparison.document.fileRowIndex}
	scrollRequest={comparison.document.scrollRequest}
	fileFilter={comparison.document.fileFilter}
	focusedFilePath={comparison.document.focusedFilePath}
	{isMobile}
	{fontSize}
	loadingLabel={m.git_compare_loading()}
	emptyErrorLabel={m.git_compare_load_failed()}
	emptyDocumentLabel={m.git_compare_no_changes()}
	{onBack}
	onSelectFile={(filePath) => comparison.focusFile(filePath)}
	onFileFilterChange={(value) => comparison.setFileFilter(value)}
	onVisibleRowsChange={(rows) => comparison.setVisibleRows(rows)}
	{onOpenInEditor}
	composerState={comparison.document.commentComposer}
	commentFeedback={comparison.document.commentFeedback}
	commentError={comparison.document.commentError}
	commentCopyText={comparison.document.commentCopyText}
	onAddComment={(filePath, side, line) =>
		comparison.document.openCommentComposer(filePath, side, line)}
	onComposerBodyChange={(body) => comparison.document.setCommentBody(body)}
	onComposerSeverityChange={(severity) => comparison.document.setCommentSeverity(severity)}
	onComposerSubmit={() => comparison.document.submitComment(onAppendToChatDraft)}
	onComposerClose={() => comparison.document.closeCommentComposer()}
	onComposerFocusHandled={() => comparison.document.markCommentComposerFocused()}
	{onOpenChat}
/>
