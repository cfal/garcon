<script lang="ts">
	import { tick, untrack } from 'svelte';
	import {
		createVirtualizer,
		defaultRangeExtractor,
		observeElementRect,
		type Range,
		type Rect,
		type Virtualizer,
	} from '@tanstack/svelte-virtual';
	import type { FileTreeEntry } from '$shared/file-contracts';
	import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
	import {
		buildFileTreeRenderModel,
		type FileTreeRenderModel,
	} from '$lib/files/tree/file-tree-render-rows.js';
	import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import { isImageFilePath } from '$lib/utils/file-kind.js';
	import * as m from '$lib/paraglide/messages.js';
	import FileTreeColumnHeader from './FileTreeColumnHeader.svelte';
	import FileTreeRenderRow from './FileTreeRenderRow.svelte';
	import { FileTreeInteractionState } from './FileTreeInteractionState.svelte.js';
	import {
		captureFileTreeVirtualAnchor,
		resolveFileTreeAnchorIndex,
	} from './file-tree-virtual-anchor.js';

	const FILE_TREE_HEADER_HEIGHT = 32;
	const FILE_TREE_ROW_HEIGHT = 32;
	const FILE_TREE_COARSE_ROW_HEIGHT = 44;
	const FILE_TREE_VIRTUAL_OVERSCAN = 8;
	const FILE_TREE_FALLBACK_VIEWPORT_HEIGHT = 640;

	let {
		store,
		selectedPath = null,
		onFileSelect,
		onImageSelect,
	}: {
		store: FileTreeStore;
		selectedPath?: string | null;
		onFileSelect: (entry: FileTreeEntry) => void;
		onImageSelect?: (entry: FileTreeEntry) => void;
	} = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let coarsePointer = $state(false);
	let semanticRows = $derived(store.filteredRows);
	let model = $derived(
		buildFileTreeRenderModel({
			rows: semanticRows,
			parentPath: store.parentPath,
			expandedDirectories: store.expandedDirs,
			loadingDirectories: store.loadingDirs,
			childErrors: store.childErrors,
		}),
	);
	let orderingModeKey = $derived(
		JSON.stringify([
			store.filterInput,
			store.sortKey,
			store.sortDirection,
			store.foldersFirst,
			store.showHiddenFiles,
		]),
	);
	let minimumTableWidth = $derived(store.visibleColumnKeys.length === 1 ? '240px' : '520px');
	let focusRequestToken = 0;
	let explicitFocusRequestPending = false;
	let pendingFocusKey: string | null = null;
	let previousModel: FileTreeRenderModel | null = null;
	let previousOrderingModeKey = '';
	let previousCoarsePointer = false;
	let modelChangeHadRowDomFocus = false;

	const interaction = new FileTreeInteractionState({
		get model() {
			return model;
		},
		get store() {
			return store;
		},
		requestDomFocus: (key) => void focusVirtualRow(key),
		activateEntry,
	});
	let activeFocusKey = $derived(interaction.activeFocusKey);

	function activateEntry(row: FileTableRow): void {
		if (row.entry.type === 'directory') {
			void store.enterDirectory(row.entry);
		} else if (isImageFilePath(row.entry.name)) {
			onImageSelect?.(row.entry);
		} else {
			onFileSelect(row.entry);
		}
	}

	function withFallbackRect(rect: Rect): Rect {
		return rect.height > 0 ? rect : { ...rect, height: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT };
	}

	function observeFileTreeElementRect(
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
		callback: (rect: Rect) => void,
	) {
		return observeElementRect(instance, (rect) => callback(withFallbackRect(rect)));
	}

	const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewportRef,
		getItemKey: (index) => model.rows[index]?.key ?? index,
		estimateSize: () => (coarsePointer ? FILE_TREE_COARSE_ROW_HEIGHT : FILE_TREE_ROW_HEIGHT),
		measureElement: (element) =>
			element.getBoundingClientRect().height ||
			(coarsePointer ? FILE_TREE_COARSE_ROW_HEIGHT : FILE_TREE_ROW_HEIGHT),
		observeElementRect: observeFileTreeElementRect,
		initialRect: { width: 0, height: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT },
		overscan: FILE_TREE_VIRTUAL_OVERSCAN,
		scrollMargin: FILE_TREE_HEADER_HEIGHT,
		scrollPaddingStart: FILE_TREE_HEADER_HEIGHT,
	});
	let virtualItems = $derived($virtualizer.getVirtualItems());
	let totalHeight = $derived($virtualizer.getTotalSize());

	function retainedFocusRange(range: Range, activeIndex: number | undefined): number[] {
		const indexes = defaultRangeExtractor(range);
		if (activeIndex !== undefined && !indexes.includes(activeIndex)) indexes.push(activeIndex);
		return indexes.sort((left, right) => left - right);
	}

	$effect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const media = window.matchMedia('(pointer: coarse)');
		const syncPointerMode = (): void => {
			coarsePointer = media.matches;
		};
		syncPointerMode();
		media.addEventListener('change', syncPointerMode);
		return () => media.removeEventListener('change', syncPointerMode);
	});

	$effect.pre(() => {
		const nextModel = model;
		const oldModel = previousModel;
		const viewport = viewportRef;
		if (!oldModel || oldModel === nextModel || !viewport) return;
		const activeElement = document.activeElement;
		const focusedRow =
			activeElement instanceof HTMLElement
				? activeElement.closest<HTMLElement>('[data-file-tree-row]')
				: null;
		modelChangeHadRowDomFocus = Boolean(focusedRow && viewport.contains(focusedRow));
	});

	$effect(() => {
		const nextModel = model;
		const scrollElement = viewportRef;
		const estimatedHeight = coarsePointer ? FILE_TREE_COARSE_ROW_HEIGHT : FILE_TREE_ROW_HEIGHT;
		const activeIndex = activeFocusKey ? nextModel.renderIndexByKey.get(activeFocusKey) : undefined;
		const nextOrderingModeKey = orderingModeKey;
		const oldModel = previousModel;
		const modelChanged = oldModel !== null && oldModel !== nextModel;
		const orderingChanged = oldModel !== null && previousOrderingModeKey !== nextOrderingModeKey;
		const coarsePointerChanged = oldModel !== null && previousCoarsePointer !== coarsePointer;
		const anchor =
			oldModel &&
			scrollElement &&
			(modelChanged || coarsePointerChanged) &&
			!orderingChanged &&
			!explicitFocusRequestPending
				? captureFileTreeVirtualAnchor(
						oldModel.rows,
						untrack(() => $virtualizer.getVirtualItems()),
						scrollElement.scrollTop,
					)
				: null;

		untrack(() => {
			$virtualizer.setOptions({
				count: nextModel.rows.length,
				getScrollElement: () => scrollElement,
				getItemKey: (index) => nextModel.rows[index]?.key ?? index,
				estimateSize: () => estimatedHeight,
				measureElement: (element) => element.getBoundingClientRect().height || estimatedHeight,
				observeElementRect: observeFileTreeElementRect,
				initialRect: { width: 0, height: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT },
				overscan: FILE_TREE_VIRTUAL_OVERSCAN,
				scrollMargin: FILE_TREE_HEADER_HEIGHT,
				scrollPaddingStart: FILE_TREE_HEADER_HEIGHT,
				rangeExtractor: (range) => retainedFocusRange(range, activeIndex),
			});
			if (coarsePointerChanged) $virtualizer.measure();
			const pendingFocusIndex = pendingFocusKey
				? nextModel.renderIndexByKey.get(pendingFocusKey)
				: undefined;
			if (pendingFocusIndex !== undefined) {
				$virtualizer.scrollToIndex(pendingFocusIndex, { align: 'auto' });
			}
		});

		if (oldModel && modelChanged) {
			interaction.reconcileFocusedRow(oldModel, modelChangeHadRowDomFocus);
		}
		if (!explicitFocusRequestPending) {
			if (orderingChanged) {
				untrack(() => $virtualizer.scrollToOffset(0));
			} else if (anchor && oldModel) {
				const anchorIndex = resolveFileTreeAnchorIndex(anchor, oldModel.rows, nextModel);
				const alignedOffset =
					anchorIndex === null
						? null
						: untrack(() => $virtualizer.getOffsetForIndex(anchorIndex, 'start'));
				if (alignedOffset) {
					const itemStart = alignedOffset[0] + FILE_TREE_HEADER_HEIGHT;
					untrack(() => $virtualizer.scrollToOffset(itemStart - anchor.offsetFromContentViewport));
				}
			}
		}

		previousModel = nextModel;
		previousOrderingModeKey = nextOrderingModeKey;
		previousCoarsePointer = coarsePointer;
		modelChangeHadRowDomFocus = false;
	});

	$effect(() => {
		const focusPath = store.focusPathAfterNavigation;
		store.currentDirectoryPath;
		if (!focusPath || !viewportRef) return;
		untrack(() => {
			interaction.focusRow(focusPath);
			store.consumeFocusPathAfterNavigation();
		});
	});

	async function focusVirtualRow(key: string): Promise<void> {
		const index = model.renderIndexByKey.get(key);
		if (index === undefined) return;
		const token = ++focusRequestToken;
		explicitFocusRequestPending = true;
		pendingFocusKey = key;
		untrack(() => $virtualizer.scrollToIndex(index, { align: 'auto' }));
		await tick();
		if (token !== focusRequestToken) return;
		if (focusMountedVirtualRow(key)) {
			explicitFocusRequestPending = false;
			pendingFocusKey = null;
			return;
		}
		await new Promise<void>((resolve) => {
			if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
			else queueMicrotask(resolve);
		});
		if (token !== focusRequestToken) return;
		focusMountedVirtualRow(key);
		explicitFocusRequestPending = false;
		pendingFocusKey = null;
	}

	function focusMountedVirtualRow(key: string): boolean {
		const target = [
			...(viewportRef?.querySelectorAll<HTMLElement>('[data-file-tree-row-key]') ?? []),
		].find((element) => element.dataset.fileTreeRowKey === key);
		target?.focus({ preventScroll: true });
		return Boolean(target);
	}

	function measureVirtualRow(element: HTMLDivElement): { destroy: () => void } {
		$virtualizer.measureElement(element);
		return {
			destroy() {
				$virtualizer.measureElement(null);
			},
		};
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
</script>

<div
	bind:this={viewportRef}
	role="treegrid"
	aria-label={`${m.filetree_project_files()}: ${store.currentDirectoryLabel}`}
	aria-rowcount={model.rows.length + 1}
	aria-colcount={store.visibleColumnKeys.length}
	aria-busy={store.isRefreshing}
	class="min-h-0 flex-1 overflow-auto overscroll-contain"
	data-file-tree-grid
>
	<div style={`min-width: ${minimumTableWidth}`}>
		<FileTreeColumnHeader {store} ariaRowIndex={1} />
		{#if model.rows.length > 0}
			<div class="relative w-full" style:height={`${totalHeight}px`}>
				{#each virtualItems as virtualItem (virtualItem.key)}
					{@const row = model.rows[virtualItem.index]}
					{#if row}
						<div
							role="presentation"
							data-index={virtualItem.index}
							data-file-tree-virtual-row
							use:measureVirtualRow
							class="absolute left-0 top-0 w-full"
							style:transform={`translateY(${virtualItem.start - FILE_TREE_HEADER_HEIGHT}px)`}
						>
							<svelte:boundary>
								<FileTreeRenderRow
									{row}
									{store}
									ariaRowIndex={virtualItem.index + 2}
									focused={activeFocusKey === row.key}
									selected={row.kind === 'entry' && selectedPath === row.entry.path}
									onActivate={() => interaction.activateRow(row)}
									onFocus={() => interaction.setFocusedKey(row.key)}
									onKeydown={(event) => interaction.handleRowKeydown(event, row)}
								/>
								{#snippet failed(error)}
									<div
										role="row"
										aria-rowindex={virtualItem.index + 2}
										aria-level={row.level}
										class="file-tree-render-error grid h-8 min-h-8 items-center overflow-hidden px-3 text-xs text-destructive"
									>
										<div role="gridcell" class="truncate">
											{row.kind === 'entry' ? `${row.entry.name}: ` : ''}{errorMessage(error)}
										</div>
									</div>
								{/snippet}
							</svelte:boundary>
						</div>
					{/if}
				{/each}
			</div>
		{/if}

		{#if semanticRows.length === 0 && !store.filterInput}
			<div class="px-4 py-10 text-center">
				<h3 class="text-sm font-medium text-foreground">{m.filetree_no_files_found()}</h3>
			</div>
		{:else if semanticRows.length === 0}
			<div class="px-4 py-10 text-center">
				<h3 class="text-sm font-medium text-foreground">{m.filetree_no_matching_rows()}</h3>
				<button
					type="button"
					class="mt-3 inline-flex h-8 items-center rounded-md border border-border px-3 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					onclick={() => store.clearFilter()}
				>
					{m.filetree_clear_filter()}
				</button>
			</div>
		{/if}
	</div>
</div>

<style>
	@media (pointer: coarse) {
		.file-tree-render-error {
			height: 44px;
			min-height: 44px;
		}
	}
</style>
