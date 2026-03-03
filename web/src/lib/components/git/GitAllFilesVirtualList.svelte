<script lang="ts">
	// Virtualizes the all-files diff stack at the file-card level.
	// Uses estimated heights with resize-based corrections to keep
	// the DOM footprint bounded while scrolling through large change sets.

	import GitDiffViewer from './GitDiffViewer.svelte';
	import type { GitFileReviewData, GitReviewCommentDraft, GitDiffTab } from '$lib/api/git.js';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';

	interface VirtualListItem {
		filePath: string;
		reviewData: GitFileReviewData | null;
	}

	interface Props {
		items: VirtualListItem[];
		activeTab: GitDiffTab;
		diffMode: DiffMode;
		selectedLineKeys: Set<string>;
		overscan?: number;
		onRequestLoad: (filePaths: string[]) => void;
		onToggleLineSelection: (key: string) => void;
		onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
		onStageHunk: (hunkIndex: number) => void;
		onUnstageHunk: (hunkIndex: number) => void;
		onStageLine?: (diffLineIndex: number) => void;
		onUnstageLine?: (diffLineIndex: number) => void;
		onAddCommentForFile: (filePath: string, side: 'before' | 'after', line: number) => void;
		commentsForFile?: (filePath: string) => GitReviewCommentDraft[];
		composerState?: { open: boolean; filePath: string; side: 'before' | 'after'; line: number; body: string; severity: 'note' | 'warning' | 'blocker' } | null;
		onComposerBodyChange?: (body: string) => void;
		onComposerSeverityChange?: (severity: 'note' | 'warning' | 'blocker') => void;
		onComposerSubmit?: () => void;
		onComposerClose?: () => void;
		onEditComment?: (id: string, patch: Partial<GitReviewCommentDraft>) => void;
		onRemoveComment?: (id: string) => void;
		scrollToRequest?: { filePath: string; token: number } | null;
	}

	let {
		items,
		activeTab,
		diffMode,
		selectedLineKeys,
		overscan = 5,
		onRequestLoad,
		onToggleLineSelection,
		onSelectLineRange,
		onStageHunk,
		onUnstageHunk,
		onStageLine,
		onUnstageLine,
		onAddCommentForFile,
		commentsForFile,
		composerState,
		onComposerBodyChange,
		onComposerSeverityChange,
		onComposerSubmit,
		onComposerClose,
		onEditComment,
		onRemoveComment,
		scrollToRequest = null,
	}: Props = $props();

	const DEFAULT_HEIGHT = 400;

	let viewport: HTMLDivElement | undefined = $state();
	let scrollTop = $state(0);
	let viewportHeight = $state(0);

	// Measured heights per file path, updated by ResizeObserver
	let measuredHeights = $state<Record<string, number>>({});

	function getItemHeight(filePath: string): number {
		return measuredHeights[filePath] ?? DEFAULT_HEIGHT;
	}

	let offsets = $derived.by(() => {
		const out: number[] = [];
		let y = 0;
		for (const item of items) {
			out.push(y);
			y += getItemHeight(item.filePath);
		}
		return out;
	});

	let totalHeight = $derived(
		items.length === 0
			? 0
			: offsets[offsets.length - 1] + getItemHeight(items[items.length - 1].filePath),
	);

	// Binary search for the first item whose bottom edge is at or past scrollTop
	function findStartIndex(top: number): number {
		let lo = 0;
		let hi = items.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (offsets[mid] + getItemHeight(items[mid].filePath) <= top) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	let startIndex = $derived(Math.max(0, findStartIndex(scrollTop) - overscan));
	let endIndex = $derived.by(() => {
		const bottom = scrollTop + viewportHeight;
		let idx = startIndex;
		while (idx < items.length && offsets[idx] < bottom) idx++;
		return Math.min(items.length, idx + overscan);
	});

	let visibleItems = $derived(items.slice(startIndex, endIndex));

	function handleScroll(): void {
		if (!viewport) return;
		scrollTop = viewport.scrollTop;
	}

	// Track viewport height
	$effect(() => {
		if (!viewport) return;
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				viewportHeight = entry.contentRect.height;
			}
		});
		ro.observe(viewport);
		return () => ro.disconnect();
	});

	// Measure rendered items via ResizeObserver
	let itemContainer: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!itemContainer) return;
		const ro = new ResizeObserver((entries) => {
			const updates: Record<string, number> = {};
			let changed = false;
			for (const entry of entries) {
				const el = entry.target as HTMLElement;
				const fp = el.dataset.filePath;
				if (!fp) continue;
				const h = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
				if (h > 0 && h !== measuredHeights[fp]) {
					updates[fp] = h;
					changed = true;
				}
			}
			if (changed) {
				measuredHeights = { ...measuredHeights, ...updates };
			}
		});

		const observe = (): void => {
			ro.disconnect();
			if (!itemContainer) return;
			for (const child of itemContainer.children) {
				if (child instanceof HTMLElement && child.dataset.filePath) {
					ro.observe(child);
				}
			}
		};

		observe();
		const mo = new MutationObserver(observe);
		mo.observe(itemContainer, { childList: true });
		return () => { ro.disconnect(); mo.disconnect(); };
	});

	// Plain (non-reactive) tracking to prevent cascading loads when
	// ResizeObserver height corrections expand the visible range.
	// Not $state because mutations must NOT re-trigger the effect.
	let requestedPaths = new Set<string>();
	let lastItemsRef: VirtualListItem[] = [];

	// Request diffs for visible items that lack data and haven't
	// already been requested. The requestedPaths guard breaks the
	// feedback loop: height corrections may reveal new indices, but
	// already-requested paths won't re-trigger onRequestLoad.
	$effect(() => {
		// Reset tracking when items list identity changes (tab switch, tree reload)
		if (items !== lastItemsRef) {
			lastItemsRef = items;
			requestedPaths = new Set();
		}

		const toLoad = visibleItems
			.filter((item) => !item.reviewData && !requestedPaths.has(item.filePath))
			.map((item) => item.filePath);
		if (toLoad.length > 0) {
			for (const fp of toLoad) requestedPaths.add(fp);
			onRequestLoad(toLoad);
		}
	});

	// Scrolls the virtual list to the requested file card.
	$effect(() => {
		if (!scrollToRequest || !viewport) return;
		const index = items.findIndex((item) => item.filePath === scrollToRequest.filePath);
		if (index === -1) return;
		viewport.scrollTop = Math.max(0, offsets[index] - 8);
	});
</script>

{#if items.length === 0}
	<div class="h-full flex items-center justify-center text-sm text-muted-foreground">
		No changed files match the current filter
	</div>
{:else}
	<div
		bind:this={viewport}
		onscroll={handleScroll}
		class="flex-1 overflow-auto"
	>
		<div style="height:{totalHeight}px; position:relative;" bind:this={itemContainer}>
			{#each visibleItems as item, i (item.filePath)}
				{@const idx = startIndex + i}
				<div
					data-file-path={item.filePath}
					style="position:absolute; top:{offsets[idx]}px; left:0; right:0;"
				>
					<div class="border-b border-border min-h-48">
						<GitDiffViewer
							reviewData={item.reviewData}
							{activeTab}
							{diffMode}
							{selectedLineKeys}
							isLoading={!item.reviewData}
							readOnly
							{onToggleLineSelection}
							{onSelectLineRange}
							{onStageHunk}
							{onUnstageHunk}
							{onStageLine}
							{onUnstageLine}
							onAddComment={(side, line) => onAddCommentForFile(item.filePath, side, line)}
							comments={commentsForFile?.(item.filePath) ?? []}
							{composerState}
							{onComposerBodyChange}
							{onComposerSeverityChange}
							{onComposerSubmit}
							{onComposerClose}
							{onEditComment}
							{onRemoveComment}
						/>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}
