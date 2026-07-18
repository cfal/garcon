<script lang="ts">
	import { untrack } from 'svelte';
	import History from '@lucide/svelte/icons/history';
	import type { DiffMode } from '$lib/git/workbench/git-workbench-types.js';
	import {
		type GitHistoryRevertTarget,
		type GitHistoryController,
	} from '$lib/git/history/git-history.svelte.js';
	import GitCommitDetailsScreen from './GitCommitDetailsScreen.svelte';
	import GitCommitListScreen from './GitCommitListScreen.svelte';

	interface GitHistoryViewProps {
		history: GitHistoryController;
		projectPath: string | null;
		effectiveProjectKey: string | null;
		isMobile: boolean;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: number;
		refreshToken?: number;
		onRevertCommit: (commit: GitHistoryRevertTarget) => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		history,
		projectPath,
		effectiveProjectKey,
		isMobile,
		diffMode,
		contextLines,
		diffFontSize,
		refreshToken = 0,
		onRevertCommit,
		onOpenInEditor,
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
