import { tick, untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
import type {
	FileTreeRenderModel,
	FileTreeRenderRow,
} from '$lib/files/tree/file-tree-render-rows.js';
import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
import {
	virtualItems as selectVirtualItems,
	type VirtualItem,
	type VirtualListSnapshot,
	type VirtualRange,
} from '$lib/virt/virtual-list-types.js';
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

interface FileTreeVirtualControllerOptions {
	get model(): FileTreeRenderModel;
	get orderingModeKey(): string;
	get viewport(): HTMLElement | null;
	get store(): FileTreeStore;
	get geometry(): FileTreeViewGeometry;
	activateEntry(row: FileTableRow): void;
}

function inclusiveIndexes(range: VirtualRange | null): number[] {
	if (!range) return [];
	return Array.from(
		{ length: range.endIndex - range.startIndex + 1 },
		(_, offset) => range.startIndex + offset,
	);
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
	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement>;

	#virt: VirtualListController;
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
	#destroyed = false;

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
		this.#virt = new VirtualListController({
			get overscan() {
				return FILE_TREE_VIRTUAL_OVERSCAN;
			},
			get measurementAnchor() {
				return 'geometric' as const;
			},
			onTransaction: (record) => {
				if (record.scrollWrites > 0) this.physicalScrollOffset = record.attainedScrollTop;
			},
		});
		this.viewport = (element) => this.#attachViewport(element);
		this.sizer = this.#virt.sizer;

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
			void this.#virt.snapshot.revision;
			const viewport = options.viewport;
			if (viewport) untrack(() => this.#syncViewport(viewport));
		});

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

	get snapshot(): VirtualListSnapshot {
		return this.#virt.snapshot;
	}

	rowAt(index: number): FileTreeRenderRow | undefined {
		return this.#virtualModel.rows[index];
	}

	renderedItems(snapshot: VirtualListSnapshot): readonly VirtualItem[] {
		const indexes = inclusiveIndexes(snapshot.overscanRange ?? this.#fallbackRange());
		const activeFocusKey = this.activeFocusKey;
		const activeIndex = activeFocusKey
			? this.#virtualModel.renderIndexByKey.get(activeFocusKey)
			: undefined;
		if (activeIndex !== undefined) indexes.push(activeIndex);
		return selectVirtualItems(snapshot, indexes);
	}

	getVirtualRowOffset = (index: number): number =>
		fileTreeVirtualRowOffset(
			this.#virtualLayout,
			index,
			this.physicalScrollOffset,
			FILE_TREE_VIRTUAL_OVERSCAN,
		);

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#focusRequestToken += 1;
		this.#anchorRestoreToken += 1;
		this.#virt.destroy();
	}

	get #geometryKey(): string {
		return `${this.headerHeight}:${this.rowHeight}`;
	}

	#attachViewport(element: HTMLElement): void | (() => void) {
		const detachVirt = this.#virt.viewport(element);
		const handleScroll = (): void => this.#syncViewport(element);
		element.addEventListener('scroll', handleScroll, { passive: true });
		this.#syncViewport(element);
		return () => {
			element.removeEventListener('scroll', handleScroll);
			detachVirt?.();
		};
	}

	#syncViewport(element: HTMLElement): void {
		if (this.#destroyed) return;
		this.physicalScrollOffset = element.scrollTop;
		const viewportHeight = element.clientHeight || FILE_TREE_FALLBACK_VIEWPORT_HEIGHT;
		if (this.viewportHeight !== viewportHeight) this.viewportHeight = viewportHeight;
	}

	#fallbackRange(): VirtualRange | null {
		const count = this.#virtualModel.rows.length;
		if (count === 0) return null;
		const rowHeight = this.#virtualLayout.layoutRowHeight;
		const bodyOffset = Math.max(0, this.physicalScrollOffset - this.#virtualLayout.scrollMargin);
		const visibleStart = Math.floor(bodyOffset / rowHeight);
		const visibleCount = Math.ceil(this.viewportHeight / rowHeight) + 1;
		return {
			startIndex: Math.max(0, visibleStart - FILE_TREE_VIRTUAL_OVERSCAN),
			endIndex: Math.min(count - 1, visibleStart + visibleCount + FILE_TREE_VIRTUAL_OVERSCAN),
		};
	}

	#updateVirtualizer(): void {
		const nextModel = this.options.model;
		const scrollElement = this.options.viewport;
		const rowHeight = this.rowHeight;
		const activeFocusKey = this.activeFocusKey;
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
			oldModel === null ||
			modelChanged ||
			orderingChanged ||
			geometryChanged ||
			viewportChanged ||
			scrollElementChanged;
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

		const sourceChanged = oldModel === null || modelChanged || geometryChanged;
		if (sourceChanged) {
			const result = untrack(() =>
				this.#virt.apply({
					kind: 'update',
					keys: nextModel.rows.map((row) => row.key),
					estimates: Array.from(
						{ length: nextModel.rows.length },
						() => nextLayout.layoutRowHeight,
					),
					anchor: { kind: 'none' },
				}),
			);
			if (result.kind === 'rejected') {
				console.error(`File tree virtualization rejected source geometry: ${result.reason}`);
				return;
			}
		}

		untrack(() => {
			this.#virtualModel = nextModel;
			this.#virtualLayout = nextLayout;
			this.#virtualScrollElement = scrollElement;
			this.physicalScrollOffset = scrollElement?.scrollTop ?? 0;
			const pendingFocusIndex = this.#pendingFocusKey
				? nextModel.renderIndexByKey.get(this.#pendingFocusKey)
				: undefined;
			if (pendingFocusIndex !== undefined) this.#scrollVirtualIndex(pendingFocusIndex);
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
				this.#scrollToPhysicalOffset(0);
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
		if (!this.#canRestoreAutomaticScroll(token, scrollElement, automaticRestoreBaseline)) return;
		this.#scrollToPhysicalOffset(physicalMaximum);
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
		if (!this.#canRestoreAutomaticScroll(token, scrollElement, automaticRestoreBaseline)) return;
		const anchorIndex = resolveFileTreeAnchorIndex(anchor, oldModel.rows, nextModel);
		if (anchorIndex === null) return;
		const logicalOffset =
			fileTreeLogicalItemStart(this.#virtualLayout, anchorIndex) -
			this.#virtualLayout.scrollMargin -
			anchor.offsetFromContentViewport;
		const physicalOffset = fileTreeLogicalToPhysicalOffset(this.#virtualLayout, logicalOffset);
		this.#scrollToPhysicalOffset(physicalOffset);
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
		return this.renderedItems(untrack(() => this.#virt.snapshot)).map((item) => {
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
		this.#scrollToPhysicalOffset(fileTreeLogicalToPhysicalOffset(layout, targetLogicalOffset));
	}

	#scrollToPhysicalOffset(offset: number): void {
		const firstKey = this.#virtualModel.rows[0]?.key;
		if (!firstKey) return;
		this.#virt.scrollToAnchor(firstKey, this.#virtualLayout.scrollMargin - offset);
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
