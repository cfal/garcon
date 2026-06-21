<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FileWarning from '@lucide/svelte/icons/file-warning';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import type { GitDiffTab, GitReviewCommentDraft } from '$lib/api/git.js';
	import type {
		GitAllFilesCard,
		GitDiffActionTarget,
	} from '$lib/stores/git-workbench.svelte.js';
	import type { CommentComposerState } from '$lib/stores/git/git-review-drafts.svelte';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';
	import GitDiffPreviewTable from './GitDiffPreviewTable.svelte';

	interface GitAllFilesCardProps {
		card: GitAllFilesCard;
		activeTab: GitDiffTab;
		diffMode: DiffMode;
		contextLines: number;
		fontSize: number;
		selectedFile: string | null;
		selectedLineKeys: Set<string>;
		operationPending: boolean;
		comments: GitReviewCommentDraft[];
		composerState: CommentComposerState;
		isViewed: boolean;
		onSelectFile: (filePath: string) => void;
		onLoadFullFile: (filePath: string) => void;
		onToggleCollapsed: (filePath: string) => void;
		onToggleViewed: (filePath: string) => void;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onAddComment: (filePath: string, side: 'before' | 'after', line: number) => void;
		onEditComment: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment?: (id: string) => void;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		card,
		activeTab,
		diffMode,
		contextLines,
		fontSize,
		selectedFile,
		selectedLineKeys,
		operationPending,
		comments,
		composerState,
		isViewed,
		onSelectFile,
		onLoadFullFile,
		onToggleCollapsed,
		onToggleViewed,
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onAddComment,
		onEditComment,
		onRemoveComment,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onOpenInEditor,
	}: GitAllFilesCardProps = $props();

	let isSelected = $derived(card.filePath === selectedFile);
	let canRenderRows = $derived(
		Boolean(card.reviewData && card.reviewData.rows.length > 0 && !card.reviewData.isBinary && !card.reviewData.error),
	);
	let statusLabel = $derived.by(() => {
		if (card.state === 'full') return 'Full';
		if (card.state === 'preview') return 'Preview';
		if (card.state === 'truncated') return 'Preview truncated';
		if (card.state === 'binary') return 'Binary';
		if (card.state === 'error') return 'Error';
		if (card.state === 'loading') return 'Loading';
		if (card.state === 'collapsed') return 'Collapsed';
		return 'Not loaded';
	});
	let placeholderTitle = $derived.by(() => {
		if (card.state === 'binary') return 'Binary file';
		if (card.state === 'error') return 'Diff failed';
		if (card.state === 'truncated') return 'Large diff';
		if (card.state === 'loading') return 'Loading diff';
		if (card.state === 'collapsed') return 'Collapsed';
		return 'Diff not loaded yet';
	});
	let placeholderDetail = $derived.by(() => {
		if (card.error) return card.error;
		if (card.truncatedReason) return card.truncatedReason;
		if (card.state === 'binary') return 'Binary diff is not available.';
		if (card.state === 'collapsed') return 'Expand the card to show its preview.';
		if (card.state === 'loading') return 'The visible preview is being loaded.';
		return 'Scroll the card into view to request a preview.';
	});
	let showLoadFull = $derived(card.state === 'preview' || card.state === 'truncated');
	let showPlaceholder = $derived(!canRenderRows || card.state === 'collapsed');
</script>

<article
	class="git-all-files-card overflow-hidden rounded border bg-background shadow-sm {isSelected
		? 'border-interactive-accent'
		: 'border-border'}"
	data-file-path={card.filePath}
	style="content-visibility: auto; contain-intrinsic-size: auto 420px;"
>
	<header class="flex items-center gap-2 border-b border-border bg-muted/25 px-2 py-1.5">
		<button
			type="button"
			class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			aria-label={card.state === 'collapsed' ? 'Expand diff card' : 'Collapse diff card'}
			title={card.state === 'collapsed' ? 'Expand diff card' : 'Collapse diff card'}
			onclick={() => onToggleCollapsed(card.filePath)}
		>
			{#if card.state === 'collapsed'}<ChevronRight class="h-3.5 w-3.5" />{:else}<ChevronDown class="h-3.5 w-3.5" />{/if}
		</button>
		<button
			type="button"
			class="min-w-0 flex-1 truncate text-left font-mono text-xs text-foreground hover:text-interactive-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			onclick={() => onSelectFile(card.filePath)}
			title={card.filePath}
		>
			{card.filePath}
		</button>
		<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
			{statusLabel}
		</span>
		{#if card.category !== 'normal'}
			<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
				{card.category}
			</span>
		{/if}
		{#if card.rowCount > 0}
			<span class="hidden rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
				{card.rowCount} rows
			</span>
		{/if}
		<button
			type="button"
			class="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
			onclick={() => onToggleViewed(card.filePath)}
		>
			{isViewed ? 'Viewed' : 'Mark viewed'}
		</button>
		{#if showLoadFull}
			<button
				type="button"
				class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				disabled={card.isLoadingFull}
				onclick={() => onLoadFullFile(card.filePath)}
				title="Load larger bounded diff"
			>
				{#if card.isLoadingFull}
					<LoaderCircle class="h-3 w-3 animate-spin" />
				{:else}
					<Maximize2 class="h-3 w-3" />
				{/if}
				Load full
			</button>
		{/if}
	</header>

	{#if showPlaceholder}
		<div class="flex items-start gap-2 px-3 py-5 text-xs text-muted-foreground">
			{#if card.state === 'loading' || card.isLoadingFull}
				<LoaderCircle class="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
			{:else}
				<FileWarning class="mt-0.5 h-4 w-4 shrink-0" />
			{/if}
			<div class="min-w-0">
				<div class="font-medium text-foreground">{placeholderTitle}</div>
				<div class="mt-0.5 break-words">{placeholderDetail}</div>
			</div>
		</div>
	{:else if card.reviewData}
		<svelte:boundary>
			<GitDiffPreviewTable
				filePath={card.filePath}
				reviewData={card.reviewData}
				{activeTab}
				{diffMode}
				{contextLines}
				{fontSize}
				{selectedLineKeys}
				{operationPending}
				{comments}
				{composerState}
				{onToggleLineSelection}
				{onSelectLineRange}
				{onStageHunk}
				{onUnstageHunk}
				{onStageLine}
				{onUnstageLine}
				{onAddComment}
				{onEditComment}
				{onRemoveComment}
				{onComposerBodyChange}
				{onComposerSeverityChange}
				{onComposerSubmit}
				{onComposerClose}
				{onOpenInEditor}
			/>
			{#snippet failed(error)}
				<div class="px-3 py-5 text-xs text-status-error-foreground">
					Failed to render diff preview: {error instanceof Error ? error.message : String(error)}
				</div>
			{/snippet}
		</svelte:boundary>
	{/if}
</article>
