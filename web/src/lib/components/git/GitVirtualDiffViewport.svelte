<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type {
		GitVirtualFileHeaderRow,
		GitVirtualReviewRow,
	} from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { GitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
	import type { GitReviewBodyDemand } from '$lib/git/review/git-review-body-demand.js';
	import {
		isGitReviewDemandTraceEnabled,
		traceGitReviewDemand,
	} from '$lib/git/review/git-review-demand-trace.js';
	import {
		markGitReviewFirstRow,
		markGitReviewViewportReady,
	} from '$lib/git/review/git-review-performance.js';
	import { measureVirtualRow } from './git-virtual-row-measurement.js';
	import {
		managedWorkspaceScrollRegion,
		scrollElementHalfPage,
	} from '$lib/workspace/workspace-scroll-region.js';

	interface GitVirtualDiffViewportProps {
		layoutIdentity?: string | null;
		reviewDocumentId?: string | null;
		active?: boolean;
		source: GitVirtualReviewRowSource;
		pinFileHeaders: boolean;
		fontSize: number;
		scrollToRequest: { filePath: string; token: number } | null;
		overscan?: number;
		emptyMessage?: string;
		onBodyDemand: (demand: GitReviewBodyDemand) => void;
		rowSnippet: Snippet<[GitVirtualReviewRow]>;
	}

	let {
		layoutIdentity = null,
		reviewDocumentId = null,
		active = true,
		source,
		pinFileHeaders,
		fontSize,
		scrollToRequest,
		overscan = 18,
		emptyMessage = 'No files match the current filters.',
		onBodyDemand,
		rowSnippet,
	}: GitVirtualDiffViewportProps = $props();

	let viewportRef = $state<HTMLDivElement | null>(null);
	let focusedViewportElement = $state<Element | null>(null);
	let lastScrollRequestKey = '';
	let pendingScrollRequestKey = '';
	let scrollRequestSequence = 0;
	let servicedScrollRequestId = '';
	let servicedScrollRequestState: 'pending' | 'resolved' | 'terminal' | null = null;
	let completedScrollRequestId = '';
	let measuredLayoutIdentity: string | null = null;
	let performanceFrame: number | null = null;
	let configuredMeasurementKey = '';
	let configuredScrollElement: HTMLDivElement | null = null;
	let presentedSource: GitVirtualReviewRowSource | null = null;
	let presentedMeasurementRevision = '';
	let demandEffectRuns = 0;
	let demandPublications = 0;
	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));
	const scrollKeys = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);

	let estimateSizeForOptions = (index: number): number =>
		source.estimateRowHeight(index, rowLineHeight);
	let itemKeyForOptions = (index: number): string | number => source.rowKey(index);

	const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
		count: untrack(() => source.rowCount),
		getScrollElement: () => viewportRef,
		estimateSize: estimateSizeForOptions,
		measureElement: measureVirtualRow,
		initialRect: { width: 0, height: 720 },
		overscan: 18,
		getItemKey: itemKeyForOptions,
	});

	let virtualItems = $derived($virtualizer.getVirtualItems());
	let totalHeight = $derived($virtualizer.getTotalSize());
	let windowStart = $derived(virtualItems[0]?.start ?? 0);
	let renderedVirtualItems = $derived.by(() =>
		virtualItems.flatMap((virtualItem) => {
			const row = source.rowAt(virtualItem.index);
			return row ? [{ virtualItem, row }] : [];
		}),
	);
	let pinnedFileHeader = $derived.by<GitVirtualFileHeaderRow | null>(() => {
		if (!pinFileHeaders) return null;
		const firstVisibleIndex = $virtualizer.range?.startIndex;
		if (firstVisibleIndex === undefined) return null;

		const filePath = source.filePathAt(firstVisibleIndex);
		if (!filePath) return null;

		const headerIndex = source.fileStart(filePath);
		if (headerIndex === undefined || firstVisibleIndex <= headerIndex) return null;

		const row = source.rowAt(headerIndex);
		return row?.kind === 'file-header' ? row : null;
	});
	let demandedFilePaths = $derived.by(() => {
		const first = virtualItems[0]?.index;
		const last = virtualItems.at(-1)?.index;
		if (first === undefined || last === undefined) return [];
		return source.filePathsInRange(first, last + 1);
	});
	const primaryScrollRegion = managedWorkspaceScrollRegion('primary', (element, direction) => {
		completeScrollRequest();
		scrollElementHalfPage(element, direction);
	});

	function completeScrollRequest(): void {
		if (servicedScrollRequestId) completedScrollRequestId = servicedScrollRequestId;
	}

	function handleViewportFocusIn(event: FocusEvent): void {
		focusedViewportElement = event.target instanceof Element ? event.target : null;
	}

	function handleViewportFocusOut(event: FocusEvent): void {
		const nextTarget = event.relatedTarget;
		focusedViewportElement =
			nextTarget instanceof Element && viewportRef?.contains(nextTarget) ? nextTarget : null;
	}

	function rowOwnsViewportFocus(rowId: string): boolean {
		const focusedElement = focusedViewportElement;
		if (!focusedElement?.isConnected) return false;
		return (
			focusedElement.closest<HTMLElement>('[data-git-virtual-row]')?.dataset.gitVirtualRowId ===
			rowId
		);
	}

	$effect(() => {
		const nextLayoutIdentity = layoutIdentity;
		const scrollElement = viewportRef;
		if (!scrollElement || nextLayoutIdentity === measuredLayoutIdentity) return;
		measuredLayoutIdentity = nextLayoutIdentity;
		lastScrollRequestKey = '';
		pendingScrollRequestKey = '';
		scrollRequestSequence += 1;
		servicedScrollRequestId = '';
		servicedScrollRequestState = null;
		completedScrollRequestId = '';
		untrack(() => {
			scrollElement.scrollTop = 0;
			$virtualizer.measure();
		});
	});

	$effect.pre(() => {
		const nextSource = source;
		const nextMeasurementRevision = nextSource.measurementRevision;
		const scrollElement = viewportRef;
		const preserveScroll =
			presentedSource !== null &&
			presentedSource !== nextSource &&
			presentedMeasurementRevision === nextMeasurementRevision;
		presentedSource = nextSource;
		presentedMeasurementRevision = nextMeasurementRevision;
		if (!preserveScroll || !scrollElement) return;

		const scrollTop = scrollElement.scrollTop;
		void tick().then(() => {
			if (
				source === nextSource &&
				viewportRef === scrollElement &&
				nextSource.measurementRevision === nextMeasurementRevision
			) {
				if (scrollElement.scrollTop !== scrollTop) scrollElement.scrollTop = scrollTop;
			}
		});
	});

	$effect(() => {
		const measurementRevision = source.measurementRevision;
		const count = source.rowCount;
		const scrollElement = viewportRef;
		const rowOverscan = overscan;
		const lineHeight = rowLineHeight;
		untrack(() => {
			const measurementKey = `${measurementRevision}\0${count}\0${rowOverscan}\0${lineHeight}`;
			if (
				measurementKey === configuredMeasurementKey &&
				scrollElement === configuredScrollElement
			) {
				return;
			}
			configuredMeasurementKey = measurementKey;
			configuredScrollElement = scrollElement;
			const measurementSource = source;
			estimateSizeForOptions = (index) => measurementSource.estimateRowHeight(index, lineHeight);
			itemKeyForOptions = (index) => measurementSource.rowKey(index);
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				estimateSize: estimateSizeForOptions,
				measureElement: measureVirtualRow,
				initialRect: { width: 0, height: 720 },
				overscan: rowOverscan,
				getItemKey: itemKeyForOptions,
			});
		});
	});

	$effect(() => {
		const scrollElement = viewportRef;
		if (!scrollElement) return;
		const handleKeydown = (event: KeyboardEvent) => {
			if (scrollKeys.has(event.key)) completeScrollRequest();
		};
		scrollElement.addEventListener('wheel', completeScrollRequest, { passive: true });
		scrollElement.addEventListener('touchstart', completeScrollRequest, { passive: true });
		scrollElement.addEventListener('pointerdown', completeScrollRequest, { passive: true });
		scrollElement.addEventListener('keydown', handleKeydown);
		return () => {
			scrollElement.removeEventListener('wheel', completeScrollRequest);
			scrollElement.removeEventListener('touchstart', completeScrollRequest);
			scrollElement.removeEventListener('pointerdown', completeScrollRequest);
			scrollElement.removeEventListener('keydown', handleKeydown);
		};
	});

	$effect(() => {
		demandEffectRuns += 1;
		const isActive = active;
		const documentId = reviewDocumentId;
		const filePaths = demandedFilePaths;
		if (!isActive || !documentId || filePaths.length === 0) return;
		demandPublications += 1;
		untrack(() => {
			traceGitReviewDemand({
				stage: 'viewport-demand',
				documentId,
				kind: 'viewport',
				fileCount: filePaths.length,
				firstFile: filePaths[0] ?? null,
				lastFile: filePaths.at(-1) ?? null,
			});
			onBodyDemand({
				kind: 'viewport',
				documentId,
				filePaths,
			});
		});
	});

	$effect(() => {
		const activeDocumentId = reviewDocumentId;
		const rows = renderedVirtualItems.map(({ row }) => row);
		if (!activeDocumentId || rows.length === 0) return;
		const hasPendingFile = rows.some(
			(row) => row.filePath && source.fileState(row.filePath) === 'pending',
		);
		const hasRealDiffRow = rows.some(
			(row) => row.kind === 'unified-row' || row.kind === 'split-row',
		);
		if (hasPendingFile || (!hasRealDiffRow && source.rowCount === 0)) return;
		const readyDocumentId = activeDocumentId;
		untrack(() => {
			if (performanceFrame !== null) cancelAnimationFrame(performanceFrame);
			performanceFrame = requestAnimationFrame(() => {
				performanceFrame = null;
				if (reviewDocumentId !== readyDocumentId) return;
				if (hasRealDiffRow) markGitReviewFirstRow(readyDocumentId);
				markGitReviewViewportReady(readyDocumentId);
			});
		});
		return () => {
			if (performanceFrame !== null) {
				cancelAnimationFrame(performanceFrame);
				performanceFrame = null;
			}
		};
	});

	$effect(() => {
		if (!scrollToRequest) {
			pendingScrollRequestKey = '';
			scrollRequestSequence += 1;
			return;
		}
		const isActive = active;
		if (!isActive) return;
		const requestId = `${scrollToRequest.token}\0${scrollToRequest.filePath}`;
		if (requestId === completedScrollRequestId) return;
		const targetIndex = source.fileStart(scrollToRequest.filePath);
		if (targetIndex === undefined) return;
		const targetState = source.fileState(scrollToRequest.filePath);
		if (
			targetState === 'terminal' &&
			servicedScrollRequestId === requestId &&
			servicedScrollRequestState === 'pending'
		) {
			completedScrollRequestId = requestId;
			return;
		}
		const requestKey = `${requestId}\0${targetIndex}\0${targetState}`;
		if (requestKey === lastScrollRequestKey || requestKey === pendingScrollRequestKey) return;
		pendingScrollRequestKey = requestKey;
		const requestSequence = ++scrollRequestSequence;
		const start = Math.max(0, targetIndex - 6);
		const end = Math.min(source.rowCount, targetIndex + 36);
		const priorityFilePaths = source.filePathsInRange(start, end);
		const documentId = reviewDocumentId;
		untrack(() => {
			if (documentId && priorityFilePaths.length > 0) {
				traceGitReviewDemand({
					stage: 'viewport-demand',
					documentId,
					kind: 'navigation',
					fileCount: priorityFilePaths.length,
					firstFile: priorityFilePaths[0] ?? null,
					lastFile: priorityFilePaths.at(-1) ?? null,
				});
				onBodyDemand({
					kind: 'navigation',
					documentId,
					filePaths: priorityFilePaths,
				});
			}
			void tick().then(() => {
				if (requestSequence !== scrollRequestSequence || pendingScrollRequestKey !== requestKey) {
					return;
				}
				if (!active) {
					pendingScrollRequestKey = '';
					return;
				}
				if (
					!scrollToRequest ||
					`${scrollToRequest.token}\0${scrollToRequest.filePath}` !== requestId
				) {
					pendingScrollRequestKey = '';
					return;
				}
				const scrollElement = viewportRef;
				if (!scrollElement) {
					pendingScrollRequestKey = '';
					return;
				}
				pendingScrollRequestKey = '';
				lastScrollRequestKey = requestKey;
				$virtualizer.scrollToIndex(targetIndex, { align: 'start' });
				servicedScrollRequestId = requestId;
				servicedScrollRequestState = targetState;
			});
		});
	});

	$effect(() => {
		const isActive = active;
		const scrollElement = viewportRef;
		if (!scrollElement || !isGitReviewDemandTraceEnabled()) return;
		let rangeFrame: number | null = null;
		const emitRange = () => {
			const items = virtualItems;
			traceGitReviewDemand({
				stage: 'viewport-range',
				layoutIdentity,
				documentId: reviewDocumentId,
				active: isActive,
				startIndex: items[0]?.index ?? null,
				endIndex: items.at(-1)?.index ?? null,
				rowCount: source.rowCount,
				scrollTop: scrollElement.scrollTop,
				demandEffectRuns,
				publications: demandPublications,
			});
		};
		const handleScroll = () => {
			if (rangeFrame !== null) return;
			rangeFrame = requestAnimationFrame(() => {
				rangeFrame = null;
				emitRange();
			});
		};
		if (isActive) untrack(emitRange);
		scrollElement.addEventListener('scroll', handleScroll, { passive: true });
		return () => {
			scrollElement.removeEventListener('scroll', handleScroll);
			if (rangeFrame !== null) cancelAnimationFrame(rangeFrame);
		};
	});

	function measureRow(
		element: HTMLDivElement,
		_index: number,
	): { update: (index: number) => void; destroy: () => void } {
		$virtualizer.measureElement(element);
		return {
			update() {
				$virtualizer.measureElement(element);
			},
			destroy() {
				$virtualizer.measureElement(null);
			},
		};
	}
</script>

{#snippet renderRow(row: GitVirtualReviewRow)}
	<svelte:boundary>
		{@render rowSnippet(row)}
		{#snippet failed(error)}
			<div
				class="border border-status-error-border bg-status-error/10 px-3 py-2 text-xs text-status-error-foreground"
			>
				Failed to render diff row: {error instanceof Error ? error.message : String(error)}
			</div>
		{/snippet}
	</svelte:boundary>
{/snippet}

<div
	bind:this={viewportRef}
	{@attach primaryScrollRegion}
	class="min-h-0 flex-1 overflow-auto bg-muted/15"
	data-git-virtual-diff-root
	onfocusin={handleViewportFocusIn}
	onfocusout={handleViewportFocusOut}
>
	{#if source.rowCount === 0}
		<div class="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
			{emptyMessage}
		</div>
	{:else}
		<div class="relative w-full" style:height={`${totalHeight}px`}>
			{#if pinnedFileHeader}
				<div class="sticky top-0 z-20 h-0" data-git-pinned-file-header-host>
					<div
						class="absolute inset-x-0 top-0"
						data-git-pinned-file-header
						data-file-path={pinnedFileHeader.filePath}
					>
						{@render renderRow(pinnedFileHeader)}
					</div>
				</div>
			{/if}

			<!-- Keeps adjacent diff backgrounds in one flow layout; per-row transforms create fractional-DPR paint seams. -->
			<div class="absolute inset-x-0" style:top={`${windowStart}px`} data-git-virtual-row-window>
				{#each renderedVirtualItems as rendered (rendered.virtualItem.key)}
					{@const isPinnedOriginal = pinnedFileHeader?.id === rendered.row.id}
					{@const hidePinnedOriginal = isPinnedOriginal && !rowOwnsViewportFocus(rendered.row.id)}
					<div
						data-index={rendered.virtualItem.index}
						data-git-virtual-row
						data-git-virtual-row-id={rendered.row.id}
						aria-hidden={hidePinnedOriginal}
						inert={hidePinnedOriginal}
						use:measureRow={rendered.virtualItem.index}
					>
						{@render renderRow(rendered.row)}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
