<script lang="ts">
	import { untrack } from 'svelte';
	import History from '@lucide/svelte/icons/history';
	import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import {
		type GitHistoryRevertTarget,
		type GitHistoryController,
	} from '$lib/git/history/git-history.svelte.js';
	import {
		GIT_EMPTY_TREE_REVISION,
		recentCommitComparisonDefaults,
		type GitComparisonController,
		type GitComparisonDialogDefaults,
	} from '$lib/git/review/git-comparison.svelte.js';
	import GitCommitDetailsScreen from './GitCommitDetailsScreen.svelte';
	import GitCommitListScreen from './GitCommitListScreen.svelte';

	interface GitHistoryViewProps {
		history: GitHistoryController;
		comparison: GitComparisonController;
		projectPath: string | null;
		effectiveProjectKey: string | null;
		isMobile: boolean;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: number;
		refreshToken?: number;
		onRevertCommit: (commit: GitHistoryRevertTarget) => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
		onOpenComparison: (defaults: GitComparisonDialogDefaults) => void;
		onAppendToChatDraft?: ChatDraftAppend;
		onOpenChat: () => void;
		onSetDiffMode?: (mode: DiffMode) => void;
		onSetContextLines?: (lines: number) => void;
		onSetDiffFontSize?: (size: string) => void;
	}

	let {
		history,
		comparison,
		projectPath,
		effectiveProjectKey,
		isMobile,
		diffMode,
		contextLines,
		diffFontSize,
		refreshToken = 0,
		onRevertCommit,
		onOpenInEditor,
		onOpenComparison,
		onAppendToChatDraft,
		onOpenChat,
		onSetDiffMode = () => undefined,
		onSetContextLines = () => undefined,
		onSetDiffFontSize = () => undefined,
	}: GitHistoryViewProps = $props();

	let loadedProjectPath = $state<string | null>(null);
	let loadedEffectiveProjectKey = $state<string | null>(null);
	let lastRefreshToken = $state(0);

	$effect(() => {
		const project = projectPath;
		const projectKey = effectiveProjectKey;
		untrack(() => {
			if (!project || !projectKey) {
				loadedProjectPath = null;
				loadedEffectiveProjectKey = null;
				history.resetForProject(null);
				return;
			}
			if (loadedProjectPath === project && loadedEffectiveProjectKey === projectKey) return;
			const identityChanged =
				loadedEffectiveProjectKey !== null && loadedEffectiveProjectKey !== projectKey;
			loadedProjectPath = project;
			loadedEffectiveProjectKey = projectKey;
			if (identityChanged) history.resetForProject(project);
			history.ensureInitialLoaded(project);
		});
	});

	$effect(() => {
		const project = projectPath;
		const mode = diffMode;
		const context = contextLines;
		untrack(() => {
			history.setDisplayOptions(project, mode, context);
			if (project) comparison.setDisplayOptions(project, mode, context);
		});
	});

	$effect(() => {
		const project = projectPath;
		const token = refreshToken;
		untrack(() => {
			if (token === lastRefreshToken) return;
			lastRefreshToken = token;
			if (project) history.loadInitial(project);
		});
	});

	function revertListCommit(commit: { hash: string; shortHash: string; subject: string }): void {
		onRevertCommit({
			hash: commit.hash,
			shortHash: commit.shortHash,
			subject: commit.subject,
		});
	}

	function openSelectedHistoryRange(): void {
		const defaults = comparison.takeSelectedHistoryRange();
		if (defaults) onOpenComparison(defaults);
	}

	function openHistoryComparison(): void {
		onOpenComparison(recentCommitComparisonDefaults(history.commits));
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
		comparisonSelectionActive={comparison.historySelectionActive}
		comparisonSelectionSlot={comparison.historySelectionSlot}
		comparisonFrom={comparison.historySelectionFrom}
		comparisonTo={comparison.historySelectionTo}
		onBeginComparison={() => comparison.beginHistorySelection()}
		onCancelComparison={() => comparison.cancelHistorySelection()}
		onSelectComparisonCommit={(hash) => comparison.selectHistoryCommit(hash)}
		onSelectComparisonSlot={(slot) => comparison.setHistorySelectionSlot(slot)}
		onOpenComparison={openHistoryComparison}
		onOpenSelectedComparison={openSelectedHistoryRange}
	/>
{:else}
	<GitCommitDetailsScreen
		snapshot={history.commitSnapshot}
		files={history.visibleFiles}
		isLoading={history.commitLoading}
		error={history.commitError}
		rows={history.virtualRows}
		fileRowIndex={history.fileRowIndex}
		scrollRequest={history.scrollRequest}
		fileFilter={history.fileFilter}
		focusedFilePath={history.focusedFilePath}
		{isMobile}
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
		onCompare={() => {
			const snapshot = history.commitSnapshot;
			if (!snapshot) return;
			onOpenComparison({
				fromRevision: snapshot.selectedParent ?? GIT_EMPTY_TREE_REVISION,
				toKind: 'revision',
				toRevision: snapshot.commit.hash,
			});
		}}
		{onSetDiffMode}
		{onSetContextLines}
		{onSetDiffFontSize}
		onSelectFile={(file) => history.focusFile(projectPath, file)}
		onFileFilterChange={(value) => history.setFileFilter(value)}
		onVisibleRowsChange={(rows) => history.setVisibleRows(projectPath, rows)}
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
{/if}
