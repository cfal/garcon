<script lang="ts">
	import { untrack } from 'svelte';
	import History from '@lucide/svelte/icons/history';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';
	import {
		GitHistoryController,
		type GitHistoryRevertTarget,
		type GitHistoryScreen,
	} from '$lib/stores/git/git-history.svelte';
	import GitCommitDetailsScreen from './GitCommitDetailsScreen.svelte';
	import GitCommitListScreen from './GitCommitListScreen.svelte';

	interface GitHistoryViewProps {
		projectPath: string | null;
		isMobile: boolean;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: number;
		refreshToken?: number;
		onScreenChange?: (screen: GitHistoryScreen) => void;
		onRevertCommit: (commit: GitHistoryRevertTarget) => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		projectPath,
		isMobile,
		diffMode,
		contextLines,
		diffFontSize,
		refreshToken = 0,
		onScreenChange,
		onRevertCommit,
		onOpenInEditor,
	}: GitHistoryViewProps = $props();

	const history = new GitHistoryController();
	let loadedProjectPath = $state<string | null>(null);
	let lastRefreshToken = $state(0);

	$effect(() => {
		const project = projectPath;
		untrack(() => {
			if (!project) {
				loadedProjectPath = null;
				history.resetForProject(null);
				return;
			}
			if (loadedProjectPath === project) return;
			loadedProjectPath = project;
			history.loadInitial(project);
		});
	});

	$effect(() => {
		const project = projectPath;
		const mode = diffMode;
		const context = contextLines;
		untrack(() => {
			history.setDisplayOptions(project, mode, context);
		});
	});

	$effect(() => {
		const screen = history.screen;
		untrack(() => onScreenChange?.(screen));
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
		onBack={() => history.backToList()}
		onRetry={() => history.retryCommit(projectPath)}
		onSelectParent={(parent) => history.selectParent(projectPath, parent)}
		onRevertCommit={() => {
			if (history.commitSnapshot) revertListCommit(history.commitSnapshot.commit);
		}}
		onSelectFile={(file) => history.focusFile(projectPath, file)}
		onFileFilterChange={(value) => history.setFileFilter(value)}
		onVisibleRowsChange={(rows) => history.setVisibleRows(projectPath, rows)}
		{onOpenInEditor}
	/>
{/if}
