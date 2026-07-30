<script lang="ts">
	import History from '@lucide/svelte/icons/history';
	import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import {
		type GitHistoryRevertTarget,
		type GitHistoryController,
	} from '$lib/git/history/git-history.svelte.js';
	import type { GitHistoryComparisonSelectionState } from '$lib/git/history/git-history-comparison-selection.svelte.js';
	import GitCommitDetailsScreen from './GitCommitDetailsScreen.svelte';
	import GitCommitListScreen from './GitCommitListScreen.svelte';
	import GitComparisonScreen from './GitComparisonScreen.svelte';

	interface GitHistoryViewProps {
		history: GitHistoryController;
		comparisonSelection: GitHistoryComparisonSelectionState;
		projectPath: string | null;
		isMobile: boolean;
		active?: boolean;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: number;
		onRevertCommit: (commit: GitHistoryRevertTarget) => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
		onOpenSelectedComparison: () => void;
		onAppendToChatDraft?: ChatDraftAppend;
		onOpenChat: () => void;
		onSetDiffMode?: (mode: DiffMode) => void;
		onSetContextLines?: (lines: number) => void;
		onSetDiffFontSize?: (size: string) => void;
	}

	let {
		history,
		comparisonSelection,
		projectPath,
		isMobile,
		active = true,
		diffMode,
		contextLines,
		diffFontSize,
		onRevertCommit,
		onOpenInEditor,
		onOpenSelectedComparison,
		onAppendToChatDraft,
		onOpenChat,
		onSetDiffMode = () => undefined,
		onSetContextLines = () => undefined,
		onSetDiffFontSize = () => undefined,
	}: GitHistoryViewProps = $props();

	function revertListCommit(commit: { hash: string; shortHash: string; subject: string }): void {
		onRevertCommit({
			hash: commit.hash,
			shortHash: commit.shortHash,
			subject: commit.subject,
		});
	}
</script>

{#if !projectPath}
	<div class="flex flex-1 flex-col items-center justify-center text-muted-foreground">
		<History class="mb-2 h-12 w-12 opacity-50" />
		<p class="text-sm">No repository selected.</p>
	</div>
{:else if history.screen === 'list'}
	<GitCommitListScreen
		commits={history.commits}
		isLoading={history.listLoading}
		error={history.listError}
		nextOffset={history.nextOffset}
		{isMobile}
		scrollTop={history.listScrollTop}
		onOpenCommit={(hash) => history.openCommit(projectPath, hash)}
		onRevertCommit={revertListCommit}
		onLoadMore={() => history.loadMore(projectPath)}
		onScrollSave={(top) => history.saveListScrollTop(top)}
		comparisonSelectionActive={comparisonSelection.active}
		comparisonSelectionSlot={comparisonSelection.slot}
		comparisonFrom={comparisonSelection.from}
		comparisonTo={comparisonSelection.to}
		onBeginComparison={() => comparisonSelection.begin()}
		onCancelComparison={() => comparisonSelection.cancel()}
		onSelectComparisonCommit={(hash) => comparisonSelection.select(hash)}
		onSelectComparisonSlot={(slot) => comparisonSelection.setSlot(slot)}
		{onOpenSelectedComparison}
	/>
{:else if history.screen === 'commit'}
	<GitCommitDetailsScreen
		snapshot={history.commitSnapshot}
		files={history.visibleFiles}
		isLoading={history.commitLoading}
		error={history.commitError}
		source={history.rowSource}
		scrollRequest={history.scrollRequest}
		fileFilter={history.fileFilter}
		focusedFilePath={history.focusedFilePath}
		{isMobile}
		{active}
		fontSize={Number(diffFontSize) || 12}
		{diffMode}
		{contextLines}
		diffFontSize={String(diffFontSize)}
		onBack={() => history.backToList()}
		onRetry={() => history.retryCommit(projectPath)}
		onSelectParent={(parent) => history.selectParent(projectPath, parent)}
		onRevertCommit={() => {
			if (history.commitSnapshot) revertListCommit(history.commitSnapshot.commit);
		}}
		{onSetDiffMode}
		{onSetContextLines}
		{onSetDiffFontSize}
		onSelectFile={(file) => history.focusFile(projectPath, file)}
		onFileFilterChange={(value) => history.setFileFilter(value)}
		onBodyDemand={(demand) => history.handleBodyDemand(demand)}
		{onOpenInEditor}
		composerState={history.document.commentComposer}
		commentFeedback={history.document.commentFeedback}
		commentError={history.document.commentError}
		commentCopyText={history.document.commentCopyText}
		onAddComment={(filePath, side, line) =>
			history.document.openCommentComposer(filePath, side, line)}
		onComposerBodyChange={(body) => history.document.setCommentBody(body)}
		onComposerSeverityChange={(severity) => history.document.setCommentSeverity(severity)}
		onComposerSubmit={() => history.document.submitComment(onAppendToChatDraft)}
		onComposerClose={() => history.document.closeCommentComposer()}
		onComposerFocusHandled={() => history.document.markCommentComposerFocused()}
		{onOpenChat}
	/>
{:else}
	<GitComparisonScreen
		comparison={history.comparison}
		isLoading={history.comparison.isLoading}
		{isMobile}
		{active}
		fontSize={Number(diffFontSize) || 12}
		onBack={() => history.backToList()}
		onRefresh={() => {
			if (projectPath) void history.comparison.refresh(projectPath);
		}}
		{onOpenInEditor}
		{onAppendToChatDraft}
		{onOpenChat}
	/>
{/if}
