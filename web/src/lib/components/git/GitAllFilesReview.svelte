<script lang="ts">
	import { untrack } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type { GitDiffTab, GitReviewCommentDraft } from '$lib/api/git.js';
	import type {
		GitAllFilesCard as GitAllFilesCardModel,
		GitDiffActionTarget,
	} from '$lib/stores/git-workbench.svelte.js';
	import type { CommentComposerState } from '$lib/stores/git/git-review-drafts.svelte';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';
	import GitAllFilesCard from './GitAllFilesCard.svelte';

	interface GitAllFilesReviewProps {
		cards: GitAllFilesCardModel[];
		activeTab: GitDiffTab;
		diffMode: DiffMode;
		contextLines: number;
		fontSize: number;
		selectedFile: string | null;
		selectedLineKeys: Set<string>;
		operationPending: boolean;
		scrollToRequest: { filePath: string; token: number } | null;
		composerState: CommentComposerState;
		overscan?: number;
		onVisibleFilesChange: (filePaths: string[]) => void;
		onSelectFile: (filePath: string) => void;
		onLoadFullFile: (filePath: string) => void;
		onToggleCollapsed: (filePath: string) => void;
		onToggleViewed: (filePath: string) => void;
		isFileViewed: (filePath: string) => boolean;
		commentsForFile: (filePath: string) => GitReviewCommentDraft[];
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
		onStageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onUnstageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
		onAddCommentForFile: (filePath: string, side: 'before' | 'after', line: number) => void;
		onEditComment: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment?: (id: string) => void;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: GitReviewCommentDraft['severity']) => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onOpenInEditor?: (relativePath: string, line: number) => void;
	}

	let {
		cards,
		activeTab,
		diffMode,
		contextLines,
		fontSize,
		selectedFile,
		selectedLineKeys,
		operationPending,
		scrollToRequest,
		composerState,
		overscan = 5,
		onVisibleFilesChange,
		onSelectFile,
		onLoadFullFile,
		onToggleCollapsed,
		onToggleViewed,
		isFileViewed,
		commentsForFile,
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onAddCommentForFile,
		onEditComment,
		onRemoveComment,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onOpenInEditor,
	}: GitAllFilesReviewProps = $props();

	let viewportRef = $state<HTMLDivElement | null>(null);
	let lastVisibleRequestKey = '';
	let lastScrollToken = 0;

	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));

	function estimateCardHeight(index: number): number {
		const card = cards[index];
		if (!card) return 180;
		if (card.state === 'preview' || card.state === 'full' || card.state === 'truncated') {
			const rows = Math.max(1, card.rowCount);
			return 48 + rows * rowLineHeight + 18;
		}
		return 130;
	}

	const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewportRef,
		estimateSize: estimateCardHeight,
		measureElement: (element) => element.getBoundingClientRect().height,
		overscan: 0,
		getItemKey: (index) => cards[index]?.filePath ?? index,
	});

	let virtualItems = $derived($virtualizer.getVirtualItems());
	let totalHeight = $derived($virtualizer.getTotalSize());
	let visibleFilePaths = $derived.by(() =>
		virtualItems
			.map((virtualItem) => cards[virtualItem.index]?.filePath)
			.filter((filePath): filePath is string => Boolean(filePath)),
	);

	$effect(() => {
		const count = cards.length;
		const scrollElement = viewportRef;
		const rowOverscan = overscan;
		const rowHeight = rowLineHeight;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				estimateSize: (index) => {
					const card = cards[index];
					if (!card) return 180;
					if (card.state === 'preview' || card.state === 'full' || card.state === 'truncated') {
						return 48 + Math.max(1, card.rowCount) * rowHeight + 18;
					}
					return 130;
				},
				measureElement: (element) => element.getBoundingClientRect().height,
				overscan: rowOverscan,
				getItemKey: (index) => cards[index]?.filePath ?? index,
			});
		});
	});

	$effect(() => {
		const key = visibleFilePaths.join('\0');
		if (!key || key === lastVisibleRequestKey) return;
		lastVisibleRequestKey = key;
		const paths = visibleFilePaths;
		untrack(() => onVisibleFilesChange(paths));
	});

	$effect(() => {
		if (!scrollToRequest || scrollToRequest.token === lastScrollToken) return;
		lastScrollToken = scrollToRequest.token;
		const targetIndex = cards.findIndex((card) => card.filePath === scrollToRequest.filePath);
		if (targetIndex < 0) return;
		const start = Math.max(0, targetIndex - 2);
		const end = Math.min(cards.length, targetIndex + 6);
		const priorityPaths = cards.slice(start, end).map((card) => card.filePath);
		untrack(() => {
			onVisibleFilesChange(priorityPaths);
			$virtualizer.scrollToIndex(targetIndex, { align: 'start' });
		});
	});

	function measureCard(element: HTMLDivElement): { destroy: () => void } {
		$virtualizer.measureElement(element);
		return {
			destroy() {
				$virtualizer.measureElement(null);
			},
		};
	}
</script>

<div
	bind:this={viewportRef}
	class="min-h-0 flex-1 overflow-auto bg-muted/15"
	data-git-all-files-scroll-root
>
	{#if cards.length === 0}
		<div class="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
			No files match the current filters.
		</div>
	{:else}
		<div class="relative w-full" style:height={`${totalHeight}px`}>
			{#each virtualItems as virtualItem (cards[virtualItem.index]?.filePath ?? virtualItem.key)}
				{@const card = cards[virtualItem.index]}
				{#if card}
					<div
						data-index={virtualItem.index}
						use:measureCard
						class="absolute left-0 top-0 w-full px-2 py-1.5"
						style:transform={`translateY(${virtualItem.start}px)`}
					>
						<svelte:boundary>
							<GitAllFilesCard
								{card}
								{activeTab}
								{diffMode}
								{contextLines}
								{fontSize}
								{selectedFile}
								{selectedLineKeys}
								{operationPending}
								comments={commentsForFile(card.filePath)}
								{composerState}
								isViewed={isFileViewed(card.filePath)}
								{onSelectFile}
								{onLoadFullFile}
								{onToggleCollapsed}
								{onToggleViewed}
								{onToggleLineSelection}
								{onSelectLineRange}
								{onStageHunk}
								{onUnstageHunk}
								{onStageLine}
								{onUnstageLine}
								onAddComment={onAddCommentForFile}
								{onEditComment}
								{onRemoveComment}
								{onComposerBodyChange}
								{onComposerSeverityChange}
								{onComposerSubmit}
								{onComposerClose}
								{onOpenInEditor}
							/>
							{#snippet failed(error)}
								<div class="rounded border border-status-error-border bg-status-error/10 px-3 py-2 text-xs text-status-error-foreground">
									Failed to render file card: {error instanceof Error ? error.message : String(error)}
								</div>
							{/snippet}
						</svelte:boundary>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
