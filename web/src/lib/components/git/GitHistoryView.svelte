<script lang="ts">
	import { untrack } from 'svelte';
	import History from '@lucide/svelte/icons/history';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';
	import { GitHistoryController } from '$lib/stores/git/git-history.svelte';
	import GitCommitDetailsScreen from './GitCommitDetailsScreen.svelte';
	import GitCommitListScreen from './GitCommitListScreen.svelte';

	interface GitHistoryViewProps {
		projectPath: string | null;
		isMobile: boolean;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: number;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		projectPath,
		isMobile,
		diffMode,
		contextLines,
		diffFontSize,
		onOpenInEditor,
	}: GitHistoryViewProps = $props();

	const history = new GitHistoryController();
	let loadedProjectPath = $state<string | null>(null);

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
		onSelectFile={(file) => history.focusFile(projectPath, file)}
		onFileFilterChange={(value) => history.setFileFilter(value)}
		onVisibleRowsChange={(rows) => history.setVisibleRows(projectPath, rows)}
		{onOpenInEditor}
	/>
{/if}
