<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { GitCommitFileSummary, GitCommitSnapshotReady } from '$lib/api/git.js';
	import type { GitVirtualReviewRow } from '$lib/stores/git/git-workbench.svelte.js';
	import GitCommitChangedFileList from './GitCommitChangedFileList.svelte';
	import GitCommitDetailsHeader from './GitCommitDetailsHeader.svelte';
	import GitCommitVirtualDiffSurface from './GitCommitVirtualDiffSurface.svelte';

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
		onBack: () => void;
		onRetry: () => void;
		onSelectParent: (parent: string | null) => void;
		onRevertCommit: () => void;
		onSelectFile: (file: string) => void;
		onFileFilterChange: (value: string) => void;
		onVisibleRowsChange: (rows: GitVirtualReviewRow[]) => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		snapshot,
		files,
		isLoading,
		error,
		rows,
		fileRowIndex,
		scrollRequest,
		fileFilter,
		focusedFilePath,
		isMobile,
		fontSize,
		onBack,
		onRetry,
		onSelectParent,
		onRevertCommit,
		onSelectFile,
		onFileFilterChange,
		onVisibleRowsChange,
		onOpenInEditor,
	}: GitCommitDetailsScreenProps = $props();

	type MobilePane = 'files' | 'diff';
	let mobilePane = $state<MobilePane>('files');

	function mobilePaneClass(pane: MobilePane): string {
		return mobilePane === pane
			? 'text-interactive-accent border-b-2 border-interactive-accent'
			: 'text-muted-foreground hover:text-foreground';
	}

	function handleSelectFile(filePath: string): void {
		onSelectFile(filePath);
		if (isMobile) mobilePane = 'diff';
	}
</script>

<div class="flex min-h-0 flex-1 flex-col bg-background">
	{#if snapshot}
		<GitCommitDetailsHeader {snapshot} {onBack} {onSelectParent} {onRevertCommit} />
		{#if error}
			<div class="border-b border-status-error-border bg-status-error/10 px-3 py-1.5 text-xs text-status-error-foreground">
				{error}
			</div>
		{/if}
		{#if isLoading}
			<div class="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
				<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
				Loading commit details
			</div>
		{/if}
		{#if isMobile}
			<div class="flex border-b border-border">
				<button
					type="button"
					class="flex-1 px-3 py-1.5 text-xs font-medium transition-colors {mobilePaneClass('files')}"
					onclick={() => {
						mobilePane = 'files';
					}}
				>
					Files <span class="text-[10px] opacity-70">({files.length})</span>
				</button>
				<button
					type="button"
					class="flex-1 px-3 py-1.5 text-xs font-medium transition-colors {mobilePaneClass('diff')}"
					onclick={() => {
						mobilePane = 'diff';
					}}
				>
					Diff
				</button>
			</div>
			<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
				{#if mobilePane === 'files'}
					<GitCommitChangedFileList
						{files}
						{fileFilter}
						{focusedFilePath}
						{isMobile}
						onFileFilterChange={onFileFilterChange}
						onSelectFile={handleSelectFile}
					/>
				{:else}
					<GitCommitVirtualDiffSurface
						{rows}
						{fileRowIndex}
						{fontSize}
						scrollToRequest={scrollRequest}
						overscan={3}
						onVisibleRowsChange={onVisibleRowsChange}
						onSelectFile={handleSelectFile}
						{onOpenInEditor}
					/>
				{/if}
			</div>
		{:else}
			<div class="flex min-h-0 flex-1 flex-row overflow-hidden">
				<GitCommitChangedFileList
					{files}
					{fileFilter}
					{focusedFilePath}
					{isMobile}
					onFileFilterChange={onFileFilterChange}
					onSelectFile={handleSelectFile}
				/>
				<GitCommitVirtualDiffSurface
					{rows}
					{fileRowIndex}
					{fontSize}
					scrollToRequest={scrollRequest}
					onVisibleRowsChange={onVisibleRowsChange}
					onSelectFile={handleSelectFile}
					{onOpenInEditor}
				/>
			</div>
		{/if}
	{:else if isLoading}
		<div class="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
			<LoaderCircle class="h-5 w-5 animate-spin" />
			Loading commit
		</div>
	{:else}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
			<div class="max-w-md text-sm text-status-error-foreground">
				{error ?? 'Commit was not found.'}
			</div>
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					onclick={onBack}
				>
					Back
				</button>
				<button
					type="button"
					class="rounded bg-interactive-accent px-3 py-1.5 text-sm text-interactive-accent-foreground hover:bg-interactive-accent/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					onclick={onRetry}
				>
					Retry
				</button>
			</div>
		</div>
	{/if}
</div>
