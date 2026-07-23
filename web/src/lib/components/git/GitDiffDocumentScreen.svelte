<script lang="ts">
	import type { Snippet } from 'svelte';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import X from '@lucide/svelte/icons/x';
	import type { GitCommitFileSummary } from '$lib/api/git.js';
	import type { GitReviewCommentDraft } from '$lib/api/git.js';
	import type { CommentComposerState } from '$lib/git/review/git-review-drafts.svelte.js';
	import {
		containerPresentationForWidth,
		observeContainerWidth,
		type ContainerPresentation,
	} from '$lib/components/shared/container-presentation.js';
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import { cn } from '$lib/utils/cn';
	import GitCommitChangedFileList from './GitCommitChangedFileList.svelte';
	import GitCommitVirtualDiffSurface from './GitCommitVirtualDiffSurface.svelte';
	import { gitContainerBreakpoints } from './git-container-presentation.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitDiffDocumentScreenProps {
		header: Snippet;
		documentId: string | null;
		documentAvailable: boolean;
		files: GitCommitFileSummary[];
		isLoading: boolean;
		error: string | null;
		onDismissError?: () => void;
		rows: GitVirtualReviewRow[];
		fileRowIndex: Map<string, number>;
		scrollRequest: { filePath: string; token: number } | null;
		fileFilter: string;
		focusedFilePath: string | null;
		isMobile: boolean;
		fontSize: number;
		loadingLabel: string;
		emptyErrorLabel: string;
		emptyDocumentLabel: string;
		onBack: () => void;
		onRetry?: () => void;
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
		onComposerSeverityChange: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit: () => void;
		onComposerClose: () => void;
		onComposerFocusHandled: () => void;
		onOpenChat: () => void;
	}

	let {
		header,
		documentId,
		documentAvailable,
		files,
		isLoading,
		error,
		onDismissError,
		rows,
		fileRowIndex,
		scrollRequest,
		fileFilter,
		focusedFilePath,
		isMobile,
		fontSize,
		loadingLabel,
		emptyErrorLabel,
		emptyDocumentLabel,
		onBack,
		onRetry,
		onSelectFile,
		onFileFilterChange,
		onVisibleRowsChange,
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
	}: GitDiffDocumentScreenProps = $props();

	type SinglePane = 'files' | 'diff';
	let containerWidth = $state(0);
	let singlePane = $state<SinglePane>('files');
	const observeDetailsWidth = observeContainerWidth((width) => {
		containerWidth = width;
	});
	let containerPresentation = $derived<ContainerPresentation>(
		isMobile ? 'narrow' : containerPresentationForWidth(containerWidth, gitContainerBreakpoints),
	);
	let isSinglePane = $derived(containerPresentation === 'narrow');
	let virtualEmptyMessage = $derived(
		fileFilter.trim() ? m.git_diff_document_no_filter_matches() : emptyDocumentLabel,
	);

	function singlePaneClass(pane: SinglePane): string {
		return singlePane === pane
			? 'text-interactive-accent border-b-2 border-interactive-accent'
			: 'text-muted-foreground hover:text-foreground';
	}

	function handleSelectFile(filePath: string): void {
		onSelectFile(filePath);
		if (isSinglePane) singlePane = 'diff';
	}
</script>

<div
	class="flex min-h-0 flex-1 flex-col bg-background"
	data-git-diff-document
	data-git-history-layout={containerPresentation}
	{@attach observeDetailsWidth}
>
	{#if documentAvailable}
		{@render header()}
		{#if error}
			<div
				class="flex items-center gap-2 border-b border-status-error-border bg-status-error/10 px-3 py-1.5 text-xs text-status-error-foreground"
			>
				<span class="min-w-0 flex-1">{error}</span>
				{#if onDismissError}<button
						type="button"
						class="rounded p-1 hover:bg-status-error/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-error-border"
						aria-label={m.git_action_dismiss_error()}
						onclick={onDismissError}><X class="h-3.5 w-3.5" /></button
					>{/if}
			</div>
		{/if}
		{#if isLoading}
			<div
				class="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
			>
				<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
				{loadingLabel}
			</div>
		{/if}
		{#if isSinglePane}
			<div class="flex shrink-0 border-b border-border" data-git-history-segmented-navigation>
				{#each ['files', 'diff'] as const as pane}
					<button
						type="button"
						class="flex-1 px-3 py-1.5 text-xs font-medium transition-colors {singlePaneClass(pane)}"
						aria-pressed={singlePane === pane}
						onclick={() => (singlePane = pane)}
					>
						{pane === 'files' ? m.git_diff_document_files() : m.git_diff_document_diff()}
						{#if pane === 'files'}<span class="text-[10px] opacity-70">({files.length})</span>{/if}
					</button>
				{/each}
			</div>
		{/if}
		<div class="relative flex min-h-0 flex-1 overflow-hidden">
			<div
				class={cn(
					'flex min-h-0 flex-col overflow-hidden bg-background',
					isSinglePane ? 'absolute inset-0' : 'w-72 shrink-0 border-r border-border',
					isSinglePane && singlePane !== 'files' && 'invisible pointer-events-none',
				)}
				aria-hidden={isSinglePane && singlePane !== 'files'}
				inert={isSinglePane && singlePane !== 'files'}
				data-git-history-files-pane
			>
				<GitCommitChangedFileList
					{files}
					{fileFilter}
					{focusedFilePath}
					{onFileFilterChange}
					onSelectFile={handleSelectFile}
				/>
			</div>
			<div
				class={cn(
					'flex min-h-0 min-w-0 flex-col overflow-hidden',
					isSinglePane ? 'absolute inset-0' : 'flex-1',
					isSinglePane && singlePane !== 'diff' && 'invisible pointer-events-none',
				)}
				aria-hidden={isSinglePane && singlePane !== 'diff'}
				inert={isSinglePane && singlePane !== 'diff'}
				data-git-history-diff-pane
			>
				<GitCommitVirtualDiffSurface
					{documentId}
					{rows}
					{fileRowIndex}
					{fontSize}
					scrollToRequest={scrollRequest}
					overscan={isSinglePane ? 3 : 18}
					{onVisibleRowsChange}
					onSelectFile={handleSelectFile}
					{onOpenInEditor}
					{composerState}
					{commentFeedback}
					{commentError}
					{commentCopyText}
					{onAddComment}
					{onComposerBodyChange}
					{onComposerSeverityChange}
					{onComposerSubmit}
					{onComposerClose}
					{onComposerFocusHandled}
					{onOpenChat}
					emptyMessage={virtualEmptyMessage}
				/>
			</div>
		</div>
	{:else if isLoading}
		<div class="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
			<LoaderCircle class="h-5 w-5 animate-spin" />
			{loadingLabel}
		</div>
	{:else}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
			<div class="max-w-md text-sm text-status-error-foreground">{error ?? emptyErrorLabel}</div>
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
					onclick={onBack}>{m.git_diff_document_back()}</button
				>
				{#if onRetry}<button
						type="button"
						class="rounded bg-interactive-accent px-3 py-1.5 text-sm text-interactive-accent-foreground hover:bg-interactive-accent/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						onclick={onRetry}>{m.git_diff_document_retry()}</button
					>{/if}
			</div>
		</div>
	{/if}
</div>
