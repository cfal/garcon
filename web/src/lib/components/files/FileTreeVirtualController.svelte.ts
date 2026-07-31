import { tick, untrack } from 'svelte';
import { get, type Readable } from 'svelte/store';
import {
	createVirtualizer,
	defaultRangeExtractor,
	observeElementOffset,
	observeElementRect,
	type Range,
	type Rect,
	type SvelteVirtualizer,
	type VirtualItem,
	type Virtualizer,
} from '@tanstack/svelte-virtual';
import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
import type { FileTreeRenderModel } from '$lib/files/tree/file-tree-render-rows.js';
import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import { FileTreeInteractionState } from './FileTreeInteractionState.svelte.js';
import {
	captureFileTreeVirtualAnchor,
	resolveFileTreeAnchorIndex,
} from './file-tree-virtual-anchor.js';
import {
	createFileTreeVirtualLayout,
	fileTreeLogicalItemStart,
	fileTreeLogicalToPhysicalOffset,
	fileTreeMaximumPhysicalScrollOffset,
	fileTreePhysicalToLogicalOffset,
	fileTreeVirtualRowOffset,
	type FileTreeVirtualLayout,
} from './file-tree-virtual-layout.js';
import type { FileTreeViewGeometry } from './file-tree-view-profile.js';
export {
	FILE_TREE_COARSE_ROW_HEIGHT,
	FILE_TREE_HEADER_HEIGHT,
	FILE_TREE_ROW_HEIGHT,
} from './file-tree-view-profile.js';

const FILE_TREE_VIRTUAL_OVERSCAN = 8;
const FILE_TREE_FALLBACK_VIEWPORT_HEIGHT = 640;
const FILE_TREE_FOCUS_MOUNT_ATTEMPTS = 4;
const FILE_TREE_INITIAL_RECT = { width: 0, height: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT };

interface FileTreeVirtualControllerOptions {
	get model(): FileTreeRenderModel;
	get orderingModeKey(): string;
	get viewport(): HTMLElement | null;
	get store(): FileTreeStore;
	get geometry(): FileTreeViewGeometry;
	activateEntry(row: FileTableRow): void;
}

function withFallbackRect(rect: Rect): Rect {
	return rect.height > 0 ? rect : { ...rect, height: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT };
}

function retainedFocusRange(range: Range, activeIndex: number | undefined): number[] {
	const indexes = defaultRangeExtractor(range);
	if (activeIndex !== undefined && !indexes.includes(activeIndex)) indexes.push(activeIndex);
	return indexes.sort((left, right) => left - right);
}

async function nextAnimationFrame(): Promise<void> {
	await new Promise<void>((resolve) => {
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
		else queueMicrotask(resolve);
	});
}

export class FileTreeVirtualController {
	coarsePointer = $state(false);
	physicalScrollOffset = $state(0);
	viewportHeight = $state(FILE_TREE_FALLBACK_VIEWPORT_HEIGHT);
	readonly interaction: FileTreeInteractionState;
	readonly virtualizer: Readable<SvelteVirtualizer<HTMLElement, HTMLDivElement>>;

	#focusRequestToken = 0;
	#anchorRestoreToken = 0;
	#explicitFocusRequestPending = false;
	#pendingFocusKey: string | null = null;
	#previousModel: FileTreeRenderModel | null = null;
	#previousOrderingModeKey = '';
	#previousGeometryKey = '';
	#pendingGeometryScrollSnapshot: {
		element: HTMLElement;
		offset: number;
		geometryKey: string;
	} | null = null;
	#modelChangeHadRowDomFocus = false;
	#virtualModel: FileTreeRenderModel = { rows: [], renderIndexByKey: new Map() };
	#virtualLayout = $state.raw<FileTreeVirtualLayout>(
		createFileTreeVirtualLayout({
			rowCount: 0,
			rowHeight: 1,
			viewportHeight: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT,
			scrollMargin: 0,
		}),
	);
	#virtualScrollElement: HTMLElement | null = null;

	constructor(private readonly options: FileTreeVirtualControllerOptions) {
		const geometry = options.geometry;
		this.#virtualLayout = createFileTreeVirtualLayout({
			rowCount: 0,
			rowHeight: geometry.fineRowHeight,
			viewportHeight: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT,
			scrollMargin: geometry.headerHeight,
		});
		this.#previousGeometryKey = `${geometry.headerHeight}:${geometry.fineRowHeight}`;
		this.interaction = new FileTreeInteractionState({
			get model() {
				return options.model;
			},
			get store() {
				return options.store;
			},
			requestDomFocus: (key) => void this.#focusVirtualRow(key),
			activateEntry: options.activateEntry,
		});
		this.virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
			count: 0,
			getScrollElement: this.#getVirtualScrollElement,
			getItemKey: this.#getVirtualItemKey,
			estimateSize: this.#estimateVirtualRowSize,
			measureElement: this.#measureVirtualRowSize,
			observeElementOffset: this.#observeFileTreeElementOffset,
			observeElementRect: this.#observeFileTreeElementRect,
			initialRect: FILE_TREE_INITIAL_RECT,
			overscan: FILE_TREE_VIRTUAL_OVERSCAN,
			scrollMargin: this.#virtualLayout.scrollMargin,
			scrollPaddingStart: this.#virtualLayout.scrollMargin,
		});

		$effect(() => {
			if (typeof window.matchMedia !== 'function') return;
			const media = window.matchMedia('(pointer: coarse)');
			const syncPointerMode = (): void => {
				this.coarsePointer = media.matches;
			};
			syncPointerMode();
			media.addEventListener('change', syncPointerMode);
			return () => media.removeEventListener('change', syncPointerMode);
		});

		$effect.pre(() => {
			const nextGeometryKey = this.#geometryKey;
			const viewport = options.viewport;
			if (viewport && this.#previousGeometryKey !== nextGeometryKey) {
				this.#pendingGeometryScrollSnapshot = {
					element: viewport,
					offset: viewport.scrollTop,
					geometryKey: nextGeometryKey,
				};
			}

			const nextModel = options.model;
			const oldModel = this.#previousModel;
			if (!oldModel || oldModel === nextModel || !viewport) return;
			const activeElement = document.activeElement;
			const focusedRow =
				activeElement instanceof HTMLElement
					? activeElement.closest<HTMLElement>('[data-file-tree-row]')
					: null;
			this.#modelChangeHadRowDomFocus = Boolean(focusedRow && viewport.contains(focusedRow));
		});

		$effect(() => this.#updateVirtualizer());

		$effect(() => {
			const store = options.store;
			const focusPath = store.focusPathAfterNavigation;
			if (!focusPath || !options.viewport) return;
			untrack(() => {
				this.interaction.focusRowOrFirst(focusPath);
				store.consumeFocusPathAfterNavigation();
			});
		});
	}

	get activeFocusKey(): string | null {
		return this.interaction.activeFocusKey;
	}

	get rowHeight(): number {
		return this.coarsePointer
			? this.options.geometry.coarseRowHeight
			: this.options.geometry.fineRowHeight;
	}

	get headerHeight(): number {
		return this.options.geometry.headerHeight;
	}

	get disclosureSize(): number {
		return this.coarsePointer
			? this.options.geometry.coarseDisclosureSize
			: this.options.geometry.fineDisclosureSize;
	}

	measureVirtualRow = (element: HTMLDivElement): { destroy: () => void } => {
		this.#instance().measureElement(element);
		return {
			destroy: () => this.#instance().measureElement(null),
		};
	};

	getVirtualRowOffset = (index: number): number =>
		fileTreeVirtualRowOffset(
			this.#virtualLayout,
			index,
			this.physicalScrollOffset,
			FILE_TREE_VIRTUAL_OVERSCAN,
		);

	#getVirtualScrollElement = (): HTMLElement | null => this.#virtualScrollElement;

	get #geometryKey(): string {
		return `${this.headerHeight}:${this.rowHeight}`;
	}

	#getVirtualItemKey = (index: number): string | number =>
		this.#virtualModel.rows[index]?.key ?? index;

	#estimateVirtualRowSize = (): number => this.#virtualLayout.layoutRowHeight;

	#measureVirtualRowSize = (element: Element): number =>
		this.#virtualLayout.compressed
			? this.#virtualLayout.layoutRowHeight
			: element.getBoundingClientRect().height || this.#virtualLayout.rowHeight;

	#observeFileTreeElementOffset = (
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
		callback: (offset: number, isScrolling: boolean) => void,
	) =>
		observeElementOffset(instance, (offset, isScrolling) => {
			this.physicalScrollOffset = offset;
			callback(offset, isScrolling);
		});

	#observeFileTreeElementRect = (
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
		callback: (rect: Rect) => void,
	) =>
		observeElementRect(instance, (rect) => {
			const nextRect = withFallbackRect(rect);
			const viewportHeight = instance.scrollElement?.clientHeight || nextRect.height;
			this.viewportHeight = viewportHeight;
			callback({ ...nextRect, height: viewportHeight });
		});

	#instance(): SvelteVirtualizer<HTMLElement, HTMLDivElement> {
		return get(this.virtualizer);
	}

	#updateVirtualizer(): void {
		const nextModel = this.options.model;
		const scrollElement = this.options.viewport;
		const rowHeight = this.rowHeight;
		const activeFocusKey = this.activeFocusKey;
		const activeIndex = activeFocusKey ? nextModel.renderIndexByKey.get(activeFocusKey) : undefined;
		const nextOrderingModeKey = this.options.orderingModeKey;
		const oldModel = this.#previousModel;
		const oldLayout = untrack(() => this.#virtualLayout);
		const modelChanged = oldModel !== null && oldModel !== nextModel;
		const orderingChanged =
			oldModel !== null && this.#previousOrderingModeKey !== nextOrderingModeKey;
		const viewportChanged = oldLayout.viewportHeight !== this.viewportHeight;
		const scrollElementChanged = this.#virtualScrollElement !== scrollElement;
		const nextLayout = createFileTreeVirtualLayout({
			rowCount: nextModel.rows.length,
			rowHeight,
			viewportHeight: this.viewportHeight,
			scrollMargin: this.headerHeight,
		});
		const geometryChanged =
			oldModel !== null &&
			(oldLayout.rowHeight !== nextLayout.rowHeight ||
				oldLayout.scrollMargin !== nextLayout.scrollMargin);
		const geometrySnapshot = this.#pendingGeometryScrollSnapshot;
		const capturedPhysicalScrollOffset =
			geometryChanged &&
			geometrySnapshot?.element === scrollElement &&
			geometrySnapshot.geometryKey === this.#geometryKey
				? geometrySnapshot.offset
				: (scrollElement?.scrollTop ?? 0);
		const layoutGenerationChanged =
			modelChanged || orderingChanged || geometryChanged || viewportChanged || scrollElementChanged;
		const restoreToken = layoutGenerationChanged
			? ++this.#anchorRestoreToken
			: this.#anchorRestoreToken;
		const oldPhysicalMaximum = fileTreeMaximumPhysicalScrollOffset(oldLayout);
		const nextPhysicalMaximum = fileTreeMaximumPhysicalScrollOffset(nextLayout);
		const wasAtPhysicalEnd = Math.abs(capturedPhysicalScrollOffset - oldPhysicalMaximum) <= 0.5;
		const preservePhysicalEnd =
			oldModel !== null &&
			(((viewportChanged || geometryChanged) && wasAtPhysicalEnd) ||
				(viewportChanged &&
					!geometryChanged &&
					nextPhysicalMaximum < oldPhysicalMaximum &&
					capturedPhysicalScrollOffset >= nextPhysicalMaximum - 0.5));
		const anchor =
			oldModel &&
			scrollElement &&
			(modelChanged || geometryChanged || viewportChanged) &&
			!orderingChanged &&
			!preservePhysicalEnd &&
			!this.#explicitFocusRequestPending
				? captureFileTreeVirtualAnchor(
						oldModel.rows,
						this.#logicalVirtualItems(oldLayout),
						fileTreePhysicalToLogicalOffset(oldLayout, capturedPhysicalScrollOffset),
						oldLayout.scrollMargin,
					)
				: null;
		untrack(() => {
			this.#virtualModel = nextModel;
			this.#virtualLayout = nextLayout;
			this.#virtualScrollElement = scrollElement;
			this.physicalScrollOffset = scrollElement?.scrollTop ?? 0;
			const virtualizer = this.#instance();
			virtualizer.setOptions({
				count: nextModel.rows.length,
				getScrollElement: this.#getVirtualScrollElement,
				getItemKey: this.#getVirtualItemKey,
				estimateSize: this.#estimateVirtualRowSize,
				measureElement: this.#measureVirtualRowSize,
				observeElementOffset: this.#observeFileTreeElementOffset,
				observeElementRect: this.#observeFileTreeElementRect,
				initialRect: FILE_TREE_INITIAL_RECT,
				overscan: FILE_TREE_VIRTUAL_OVERSCAN,
				scrollMargin: nextLayout.scrollMargin,
				scrollPaddingStart: nextLayout.scrollMargin,
				rangeExtractor: (range) => retainedFocusRange(range, activeIndex),
			});
			if (modelChanged || geometryChanged) {
				virtualizer.measure();
				virtualizer.getVirtualItems();
			}
			const pendingFocusIndex = this.#pendingFocusKey
				? nextModel.renderIndexByKey.get(this.#pendingFocusKey)
				: undefined;
			if (pendingFocusIndex !== undefined) {
				this.#scrollVirtualIndex(pendingFocusIndex);
			}
		});

		if (oldModel && modelChanged) {
			const reconciledFocusKey = this.interaction.reconcileFocusedRow(
				oldModel,
				this.#modelChangeHadRowDomFocus,
			);
			if (
				this.#modelChangeHadRowDomFocus &&
				reconciledFocusKey !== null &&
				reconciledFocusKey === activeFocusKey
			) {
				void this.#restoreRetainedDomFocus(reconciledFocusKey, restoreToken);
			}
		}
		if (!this.#explicitFocusRequestPending) {
			if (orderingChanged) {
				untrack(() => this.#instance().scrollToOffset(0));
			} else if (preservePhysicalEnd && scrollElement) {
				void this.#restoreVirtualEnd(restoreToken, scrollElement);
			} else if (anchor && oldModel && scrollElement) {
				void this.#restoreVirtualAnchor(anchor, oldModel, nextModel, restoreToken, scrollElement);
			}
		}

		this.#previousModel = nextModel;
		this.#previousOrderingModeKey = nextOrderingModeKey;
		this.#previousGeometryKey = this.#geometryKey;
		this.#pendingGeometryScrollSnapshot = null;
		this.#modelChangeHadRowDomFocus = false;
	}

	async #restoreVirtualEnd(token: number, scrollElement: HTMLElement): Promise<void> {
		const automaticRestoreBaseline = await this.#captureCommittedScrollBaseline(scrollElement);
		await nextAnimationFrame();
		const physicalMaximum = fileTreeMaximumPhysicalScrollOffset(this.#virtualLayout);
		if (!this.#canRestoreAutomaticScroll(token, scrollElement, automaticRestoreBaseline)) {
			return;
		}
		untrack(() => this.#instance().scrollToOffset(physicalMaximum));
	}

	async #restoreVirtualAnchor(
		anchor: NonNullable<ReturnType<typeof captureFileTreeVirtualAnchor>>,
		oldModel: FileTreeRenderModel,
		nextModel: FileTreeRenderModel,
		token: number,
		scrollElement: HTMLElement,
	): Promise<void> {
		const automaticRestoreBaseline = await this.#captureCommittedScrollBaseline(scrollElement);
		await nextAnimationFrame();
		if (!this.#canRestoreAutomaticScroll(token, scrollElement, automaticRestoreBaseline)) {
			return;
		}
		const anchorIndex = resolveFileTreeAnchorIndex(anchor, oldModel.rows, nextModel);
		if (anchorIndex === null) return;
		const logicalOffset =
			fileTreeLogicalItemStart(this.#virtualLayout, anchorIndex) -
			this.#virtualLayout.scrollMargin -
			anchor.offsetFromContentViewport;
		const physicalOffset = fileTreeLogicalToPhysicalOffset(this.#virtualLayout, logicalOffset);
		untrack(() => this.#instance().scrollToOffset(physicalOffset));
	}

	async #captureCommittedScrollBaseline(scrollElement: HTMLElement): Promise<number> {
		await tick();
		// Forces committed geometry to clamp scrollTop before the next input task.
		void scrollElement.scrollHeight;
		const offset = scrollElement.scrollTop;
		this.physicalScrollOffset = offset;
		return offset;
	}

	#canRestoreAutomaticScroll(
		token: number,
		scrollElement: HTMLElement,
		expectedPhysicalOffset: number,
	): boolean {
		return (
			token === this.#anchorRestoreToken &&
			!this.#explicitFocusRequestPending &&
			this.options.viewport === scrollElement &&
			Math.abs(scrollElement.scrollTop - expectedPhysicalOffset) <= 0.5
		);
	}

	async #restoreRetainedDomFocus(key: string, token: number): Promise<void> {
		for (let attempt = 0; attempt < FILE_TREE_FOCUS_MOUNT_ATTEMPTS; attempt += 1) {
			await tick();
			await nextAnimationFrame();
			if (token !== this.#anchorRestoreToken || this.activeFocusKey !== key) return;
			const activeElement = document.activeElement;
			if (
				activeElement instanceof HTMLElement &&
				activeElement !== document.body &&
				activeElement !== document.documentElement
			) {
				return;
			}
			if (this.#focusMountedVirtualRow(key)) return;
		}
	}

	#focusVirtualRow = async (key: string): Promise<void> => {
		const index = this.options.model.renderIndexByKey.get(key);
		if (index === undefined) return;
		const token = ++this.#focusRequestToken;
		this.#anchorRestoreToken += 1;
		this.#explicitFocusRequestPending = true;
		this.#pendingFocusKey = key;
		untrack(() => this.#scrollVirtualIndex(index));
		for (let attempt = 0; attempt < FILE_TREE_FOCUS_MOUNT_ATTEMPTS; attempt += 1) {
			await tick();
			if (token !== this.#focusRequestToken) return;
			if (this.#focusMountedVirtualRow(key)) {
				this.#clearPendingFocus(token);
				return;
			}
			untrack(() => this.#scrollVirtualIndex(index));
			await nextAnimationFrame();
		}
		if (token !== this.#focusRequestToken) return;
		this.#focusNearestMountedRow(index);
		this.#clearPendingFocus(token);
	};

	#logicalVirtualItems(layout: FileTreeVirtualLayout): VirtualItem[] {
		return untrack(() => this.#instance().getVirtualItems()).map((item) => {
			const start = fileTreeLogicalItemStart(layout, item.index);
			return { ...item, start, size: layout.rowHeight, end: start + layout.rowHeight };
		});
	}

	#scrollVirtualIndex(index: number): void {
		const scrollElement = this.#virtualScrollElement;
		if (!scrollElement) return;
		const layout = this.#virtualLayout;
		const currentLogicalOffset = fileTreePhysicalToLogicalOffset(layout, scrollElement.scrollTop);
		const itemStart = fileTreeLogicalItemStart(layout, index);
		const itemEnd = itemStart + layout.rowHeight;
		let targetLogicalOffset: number;
		if (itemEnd >= currentLogicalOffset + layout.viewportHeight) {
			targetLogicalOffset = itemEnd - layout.viewportHeight;
		} else if (itemStart <= currentLogicalOffset + layout.scrollMargin) {
			targetLogicalOffset = itemStart - layout.scrollMargin;
		} else {
			return;
		}
		this.#instance().scrollToOffset(fileTreeLogicalToPhysicalOffset(layout, targetLogicalOffset));
	}

	#focusMountedVirtualRow(key: string): boolean {
		const target = [
			...(this.options.viewport?.querySelectorAll<HTMLElement>('[data-file-tree-row-key]') ?? []),
		].find((element) => element.dataset.fileTreeRowKey === key);
		target?.focus({ preventScroll: true });
		return document.activeElement === target;
	}

	#focusNearestMountedRow(targetIndex: number): void {
		const mountedRows = [
			...(this.options.viewport?.querySelectorAll<HTMLElement>('[data-file-tree-row]') ?? []),
		];
		const target = mountedRows
			.map((element) => ({
				element,
				index: Number(element.closest<HTMLElement>('[data-index]')?.dataset.index),
			}))
			.filter((candidate) => Number.isFinite(candidate.index))
			.sort(
				(left, right) => Math.abs(left.index - targetIndex) - Math.abs(right.index - targetIndex),
			)[0]?.element;
		target?.focus({ preventScroll: true });
	}

	#clearPendingFocus(token: number): void {
		if (token !== this.#focusRequestToken) return;
		this.#explicitFocusRequestPending = false;
		this.#pendingFocusKey = null;
	}
}
