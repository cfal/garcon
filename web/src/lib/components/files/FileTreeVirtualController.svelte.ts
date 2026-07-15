import { tick, untrack } from 'svelte';
import { get, type Readable } from 'svelte/store';
import {
	createVirtualizer,
	defaultRangeExtractor,
	observeElementRect,
	type Range,
	type Rect,
	type SvelteVirtualizer,
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

export const FILE_TREE_HEADER_HEIGHT = 32;
const FILE_TREE_ROW_HEIGHT = 32;
const FILE_TREE_COARSE_ROW_HEIGHT = 44;
const FILE_TREE_VIRTUAL_OVERSCAN = 8;
const FILE_TREE_FALLBACK_VIEWPORT_HEIGHT = 640;
const FILE_TREE_FOCUS_MOUNT_ATTEMPTS = 4;
const FILE_TREE_INITIAL_RECT = { width: 0, height: FILE_TREE_FALLBACK_VIEWPORT_HEIGHT };

interface FileTreeVirtualControllerOptions {
	get model(): FileTreeRenderModel;
	get orderingModeKey(): string;
	get viewport(): HTMLElement | null;
	get store(): FileTreeStore;
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
	readonly interaction: FileTreeInteractionState;
	readonly virtualizer: Readable<SvelteVirtualizer<HTMLElement, HTMLDivElement>>;

	#focusRequestToken = 0;
	#anchorRestoreToken = 0;
	#explicitFocusRequestPending = false;
	#pendingFocusKey: string | null = null;
	#previousModel: FileTreeRenderModel | null = null;
	#previousOrderingModeKey = '';
	#previousCoarsePointer = false;
	#modelChangeHadRowDomFocus = false;
	#virtualModel: FileTreeRenderModel = { rows: [], renderIndexByKey: new Map() };
	#virtualEstimatedHeight = FILE_TREE_ROW_HEIGHT;
	#virtualScrollElement: HTMLElement | null = null;

	constructor(private readonly options: FileTreeVirtualControllerOptions) {
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
			observeElementRect: this.#observeFileTreeElementRect,
			initialRect: FILE_TREE_INITIAL_RECT,
			overscan: FILE_TREE_VIRTUAL_OVERSCAN,
			scrollMargin: FILE_TREE_HEADER_HEIGHT,
			scrollPaddingStart: FILE_TREE_HEADER_HEIGHT,
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
			const nextModel = options.model;
			const oldModel = this.#previousModel;
			const viewport = options.viewport;
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

	measureVirtualRow = (element: HTMLDivElement): { destroy: () => void } => {
		this.#instance().measureElement(element);
		return {
			destroy: () => this.#instance().measureElement(null),
		};
	};

	#getVirtualScrollElement = (): HTMLElement | null => this.#virtualScrollElement;

	#getVirtualItemKey = (index: number): string | number =>
		this.#virtualModel.rows[index]?.key ?? index;

	#estimateVirtualRowSize = (): number => this.#virtualEstimatedHeight;

	#measureVirtualRowSize = (element: Element): number =>
		element.getBoundingClientRect().height || this.#virtualEstimatedHeight;

	#observeFileTreeElementRect = (
		instance: Virtualizer<HTMLElement, HTMLDivElement>,
		callback: (rect: Rect) => void,
	) => observeElementRect(instance, (rect) => callback(withFallbackRect(rect)));

	#instance(): SvelteVirtualizer<HTMLElement, HTMLDivElement> {
		return get(this.virtualizer);
	}

	#updateVirtualizer(): void {
		const nextModel = this.options.model;
		const scrollElement = this.options.viewport;
		const estimatedHeight = this.coarsePointer ? FILE_TREE_COARSE_ROW_HEIGHT : FILE_TREE_ROW_HEIGHT;
		const activeFocusKey = this.activeFocusKey;
		const activeIndex = activeFocusKey ? nextModel.renderIndexByKey.get(activeFocusKey) : undefined;
		const nextOrderingModeKey = this.options.orderingModeKey;
		const oldModel = this.#previousModel;
		const modelChanged = oldModel !== null && oldModel !== nextModel;
		const orderingChanged =
			oldModel !== null && this.#previousOrderingModeKey !== nextOrderingModeKey;
		const coarsePointerChanged =
			oldModel !== null && this.#previousCoarsePointer !== this.coarsePointer;
		const restoreToken = ++this.#anchorRestoreToken;
		const anchor =
			oldModel &&
			scrollElement &&
			(modelChanged || coarsePointerChanged) &&
			!orderingChanged &&
			!this.#explicitFocusRequestPending
				? captureFileTreeVirtualAnchor(
						oldModel.rows,
						untrack(() => this.#instance().getVirtualItems()),
						scrollElement.scrollTop,
						FILE_TREE_HEADER_HEIGHT,
					)
				: null;

		untrack(() => {
			this.#virtualModel = nextModel;
			this.#virtualEstimatedHeight = estimatedHeight;
			this.#virtualScrollElement = scrollElement;
			const virtualizer = this.#instance();
			virtualizer.setOptions({
				count: nextModel.rows.length,
				getScrollElement: this.#getVirtualScrollElement,
				getItemKey: this.#getVirtualItemKey,
				estimateSize: this.#estimateVirtualRowSize,
				measureElement: this.#measureVirtualRowSize,
				observeElementRect: this.#observeFileTreeElementRect,
				initialRect: FILE_TREE_INITIAL_RECT,
				overscan: FILE_TREE_VIRTUAL_OVERSCAN,
				scrollMargin: FILE_TREE_HEADER_HEIGHT,
				scrollPaddingStart: FILE_TREE_HEADER_HEIGHT,
				rangeExtractor: (range) => retainedFocusRange(range, activeIndex),
			});
			if (modelChanged || coarsePointerChanged) {
				virtualizer.measure();
				virtualizer.getVirtualItems();
			}
			const pendingFocusIndex = this.#pendingFocusKey
				? nextModel.renderIndexByKey.get(this.#pendingFocusKey)
				: undefined;
			if (pendingFocusIndex !== undefined) {
				virtualizer.scrollToIndex(pendingFocusIndex, { align: 'auto' });
			}
		});

		if (oldModel && modelChanged) {
			this.interaction.reconcileFocusedRow(oldModel, this.#modelChangeHadRowDomFocus);
		}
		if (!this.#explicitFocusRequestPending) {
			if (orderingChanged) {
				untrack(() => this.#instance().scrollToOffset(0));
			} else if (anchor && oldModel) {
				void this.#restoreVirtualAnchor(anchor, oldModel, nextModel, restoreToken);
			}
		}

		this.#previousModel = nextModel;
		this.#previousOrderingModeKey = nextOrderingModeKey;
		this.#previousCoarsePointer = this.coarsePointer;
		this.#modelChangeHadRowDomFocus = false;
	}

	async #restoreVirtualAnchor(
		anchor: NonNullable<ReturnType<typeof captureFileTreeVirtualAnchor>>,
		oldModel: FileTreeRenderModel,
		nextModel: FileTreeRenderModel,
		token: number,
	): Promise<void> {
		await tick();
		await nextAnimationFrame();
		if (token !== this.#anchorRestoreToken || this.#explicitFocusRequestPending) return;
		const anchorIndex = resolveFileTreeAnchorIndex(anchor, oldModel.rows, nextModel);
		if (anchorIndex === null) return;
		const alignedOffset = untrack(() => {
			const virtualizer = this.#instance();
			virtualizer.getVirtualItems();
			return virtualizer.getOffsetForIndex(anchorIndex, 'start');
		});
		if (!alignedOffset) return;
		untrack(() =>
			this.#instance().scrollToOffset(alignedOffset[0] - anchor.offsetFromContentViewport),
		);
	}

	#focusVirtualRow = async (key: string): Promise<void> => {
		const index = this.options.model.renderIndexByKey.get(key);
		if (index === undefined) return;
		const token = ++this.#focusRequestToken;
		this.#explicitFocusRequestPending = true;
		this.#pendingFocusKey = key;
		untrack(() => this.#instance().scrollToIndex(index, { align: 'auto' }));
		for (let attempt = 0; attempt < FILE_TREE_FOCUS_MOUNT_ATTEMPTS; attempt += 1) {
			await tick();
			if (token !== this.#focusRequestToken) return;
			if (this.#focusMountedVirtualRow(key)) {
				this.#clearPendingFocus(token);
				return;
			}
			untrack(() => this.#instance().scrollToIndex(index, { align: 'auto' }));
			await nextAnimationFrame();
		}
		if (token !== this.#focusRequestToken) return;
		this.#focusNearestMountedRow(index);
		this.#clearPendingFocus(token);
	};

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
