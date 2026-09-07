<script lang="ts">
	import { onDestroy, tick, untrack, type Snippet } from 'svelte';
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
	import { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
	import {
		virtualItems as selectVirtualItems,
		type VirtualMutationAnchor,
		type VirtualRange,
	} from '$lib/virt/virtual-list-types.js';
	import { measureVirtualRow } from './git-virtual-row-measurement.js';
	import { managedWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';

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
	let servicedScrollTargetStart = Number.NaN;
	let completedScrollRequestId = '';
	let configuredLayoutIdentity: string | null | undefined;
	let performanceFrame: number | null = null;
	let configuredMeasurementKey = '';
	let configuredOverscan = Number.NaN;
	let presentedSource: GitVirtualReviewRowSource | null = null;
	let presentedMeasurementRevision = '';
	let scrollIntentRevision = 0;
	let demandEffectRuns = 0;
	let demandPublications = 0;
	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));
	const fallbackViewportHeight = 360;
	const scrollTargetTolerance = 0.5;
	const scrollKeys = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);

	const virtual = new VirtualListController({
		initialViewportSize: fallbackViewportHeight,
		get overscan() {
			return overscan;
		},
		get measurementAnchor() {
			return 'geometric' as const;
		},
		measureElement: measureVirtualRow,
	});

	let virtualSnapshot = $derived(virtual.snapshot);
	let virtualItems = $derived(
		selectVirtualItems(
			virtualSnapshot,
			indexesInRange(virtualSnapshot.overscanRange ?? fallbackRange(true)),
		),
	);
	let totalHeight = $derived(virtualSnapshot.sizerSize);
	let windowStart = $derived(virtualItems[0]?.start ?? 0);
	let renderedVirtualItems = $derived.by(() =>
		virtualItems.flatMap((virtualItem) => {
			const row = source.rowAt(virtualItem.index);
			return row ? [{ virtualItem, row }] : [];
		}),
	);
	let pinnedFileHeader = $derived.by<GitVirtualFileHeaderRow | null>(() => {
		if (!pinFileHeaders) return null;
		const firstVisibleIndex = (virtualSnapshot.visibleRange ?? fallbackRange(false))?.startIndex;
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
		virtual.scrollBy((direction === 'later' ? 1 : -1) * (element.clientHeight / 2));
	});

	function indexesInRange(range: VirtualRange | null): number[] {
		return range
			? Array.from(
					{ length: range.endIndex - range.startIndex + 1 },
					(_, offset) => range.startIndex + offset,
				)
			: [];
	}

	function fallbackRange(includeOverscan: boolean): VirtualRange | null {
		if (source.rowCount === 0) return null;
		const offset = Math.max(0, viewportRef?.scrollTop ?? 0);
		const viewportHeight = fallbackViewportHeight;
		const startIndex = virtualSnapshot.positions.itemAtOffset(offset)?.index ?? 0;
		const endIndex =
			virtualSnapshot.positions.itemAtOffset(offset + viewportHeight)?.index ?? source.rowCount - 1;
		const extra = includeOverscan ? Math.max(0, Math.floor(overscan)) : 0;
		return {
			startIndex: Math.max(0, startIndex - extra),
			endIndex: Math.min(source.rowCount - 1, endIndex + extra),
		};
	}

	function currentAnchor(): VirtualMutationAnchor {
		const position = virtual.viewportPosition;
		const item = position
			? virtual.snapshot.positions.itemAtOffset(position.paintedOffset)
			: undefined;
		return item ? { kind: 'item', key: item.key } : { kind: 'none' };
	}

	function restorePresentationOffset(
		nextSource: GitVirtualReviewRowSource,
		measurementRevision: string,
		logicalOffset: number,
		intentRevision: number,
	): void {
		void tick().then(() => {
			if (
				source !== nextSource ||
				nextSource.measurementRevision !== measurementRevision ||
				scrollIntentRevision !== intentRevision
			) {
				return;
			}
			const currentOffset = virtual.viewportPosition?.logicalOffset;
			if (currentOffset === undefined || Math.abs(currentOffset - logicalOffset) <= 0.5) return;
			virtual.scrollBy(logicalOffset - currentOffset);
		});
	}

	function completeScrollRequest(): void {
		scrollIntentRevision += 1;
		if (servicedScrollRequestId) completedScrollRequestId = servicedScrollRequestId;
		virtual.cancelOwnedScroll();
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

	$effect.pre(() => {
		const nextSource = source;
		const nextMeasurementRevision = nextSource.measurementRevision;
		const nextLayoutIdentity = layoutIdentity;
		const rowOverscan = overscan;
		const lineHeight = rowLineHeight;
		untrack(() => {
			const layoutChanged = configuredLayoutIdentity !== nextLayoutIdentity;
			const measurementKey = `${nextMeasurementRevision}\0${nextSource.rowCount}\0${lineHeight}`;
			const presentationOnly =
				!layoutChanged &&
				presentedSource !== null &&
				presentedSource !== nextSource &&
				presentedMeasurementRevision === nextMeasurementRevision &&
				measurementKey === configuredMeasurementKey;
			const restoreOffset = presentationOnly ? virtual.viewportPosition?.logicalOffset : undefined;
			const restoreIntentRevision = scrollIntentRevision;

			if (layoutChanged) {
				scrollIntentRevision += 1;
				lastScrollRequestKey = '';
				pendingScrollRequestKey = '';
				scrollRequestSequence += 1;
				servicedScrollRequestId = '';
				servicedScrollRequestState = null;
				servicedScrollTargetStart = Number.NaN;
				completedScrollRequestId = '';
			}

			if (layoutChanged || measurementKey !== configuredMeasurementKey) {
				const next = nextSource.buildVirtualMeasurements(lineHeight);
				virtual.apply({
					kind: layoutChanged ? 'reset-measurements' : 'update',
					...next,
					anchor: layoutChanged ? { kind: 'none' } : currentAnchor(),
				});
				configuredMeasurementKey = measurementKey;
			}

			if (layoutChanged) virtual.scrollToStart();
			else if (rowOverscan !== configuredOverscan) virtual.refreshLayout();
			if (restoreOffset !== undefined) {
				restorePresentationOffset(
					nextSource,
					nextMeasurementRevision,
					restoreOffset,
					restoreIntentRevision,
				);
			}

			configuredLayoutIdentity = nextLayoutIdentity;
			configuredOverscan = rowOverscan;
			presentedSource = nextSource;
			presentedMeasurementRevision = nextMeasurementRevision;
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
			servicedScrollTargetStart = Number.NaN;
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
		if (requestKey === pendingScrollRequestKey) return;
		const targetItem = virtualSnapshot.positions.itemAt(targetIndex);
		const targetGeometryUnchanged =
			targetItem !== undefined &&
			Math.abs(targetItem.start - servicedScrollTargetStart) <= scrollTargetTolerance;
		if (requestKey === lastScrollRequestKey && targetGeometryUnchanged) return;
		scrollIntentRevision += 1;
		pendingScrollRequestKey = requestKey;
		const requestSequence = ++scrollRequestSequence;
		const start = Math.max(0, targetIndex - 6);
		const end = Math.min(source.rowCount, targetIndex + 36);
		const priorityFilePaths = source.filePathsInRange(start, end);
		const documentId = reviewDocumentId;
		untrack(() => {
			if (requestKey !== lastScrollRequestKey && documentId && priorityFilePaths.length > 0) {
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
				scrollIntentRevision += 1;
				servicedScrollTargetStart =
					virtualSnapshot.positions.itemAt(targetIndex)?.start ?? Number.NaN;
				virtual.scrollToIndex(targetIndex, { align: 'start' });
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

	onDestroy(() => virtual.destroy());
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
	{@attach virtual.viewport}
	{@attach primaryScrollRegion}
	class="min-h-0 flex-1 overflow-auto bg-muted/15"
	style:overflow-anchor="none"
	data-git-virtual-diff-root
	onfocusin={handleViewportFocusIn}
	onfocusout={handleViewportFocusOut}
>
	{#if source.rowCount === 0}
		<div class="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
			{emptyMessage}
		</div>
	{:else}
		<div
			class="relative w-full"
			style:height={`${totalHeight}px`}
			data-git-virtual-diff-sizer
			{@attach virtual.sizer}
		>
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
						{@attach virtual.item(rendered.virtualItem.key)}
					>
						{@render renderRow(rendered.row)}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
