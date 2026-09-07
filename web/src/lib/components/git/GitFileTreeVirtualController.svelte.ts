import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import {
	GIT_WORKBENCH_TREE_OVERSCAN,
	GIT_WORKBENCH_TREE_ROW_HEIGHT,
	gitWorkbenchTreeRowKey,
	type GitWorkbenchTreeRow,
} from '$lib/git/workbench/git-workbench-tree-rows.js';
import { VirtualListController } from '$lib/virt/virtual-list-controller.svelte.js';
import {
	virtualItems as selectVirtualItems,
	type VirtualItem,
	type VirtualListSnapshot,
	type VirtualMutationAnchor,
	type VirtualRange,
} from '$lib/virt/virtual-list-types.js';

interface GitFileTreeVirtualControllerOptions {
	get rows(): readonly GitWorkbenchTreeRow[];
	get collapsedDirs(): ReadonlySet<string>;
	get selectedFile(): string | null;
	get viewportElement(): HTMLElement | null;
	get onSelectFile(): (path: string) => void;
	get onToggleDir(): (path: string) => void;
}

function indexesInRange(range: VirtualRange | null): number[] {
	if (!range) return [];
	return Array.from(
		{ length: range.endIndex - range.startIndex + 1 },
		(_, offset) => range.startIndex + offset,
	);
}

function indexWithinRange(index: number, range: VirtualRange): number {
	return Math.min(range.endIndex, Math.max(range.startIndex, index));
}

function focusWasLostFromDocument(): boolean {
	const activeElement = document.activeElement;
	return (
		!activeElement || activeElement === document.body || activeElement === document.documentElement
	);
}

export class GitFileTreeVirtualController {
	readonly viewport: Attachment<HTMLElement>;
	readonly sizer: Attachment<HTMLElement>;
	focusedRowKey = $state<string | null>(null);

	#virtual: VirtualListController;
	#lastRevealedSelectionKey: string | null = null;
	#virtualRenderHadTreeFocus = false;

	constructor(private readonly options: GitFileTreeVirtualControllerOptions) {
		this.#virtual = new VirtualListController({
			initialViewportSize: 720,
			get overscan() {
				return GIT_WORKBENCH_TREE_OVERSCAN;
			},
			get measurementAnchor() {
				return 'geometric' as const;
			},
		});
		this.viewport = this.#virtual.viewport;
		this.sizer = this.#virtual.sizer;

		$effect.pre(() => {
			const rows = options.rows;
			untrack(() => {
				const result = this.#virtual.apply({
					kind: 'update',
					keys: rows.map((row) => row.key),
					estimates: rows.map(() => GIT_WORKBENCH_TREE_ROW_HEIGHT),
					anchor: this.#currentAnchor(),
				});
				if (result.kind === 'rejected') {
					console.error(`Git file tree virtualization rejected source geometry: ${result.reason}`);
				}
			});
		});

		$effect.pre(() => {
			void this.#virtual.snapshot.revision;
			const viewportElement = options.viewportElement;
			this.#virtualRenderHadTreeFocus = Boolean(
				viewportElement &&
				document.activeElement &&
				viewportElement.contains(document.activeElement),
			);
		});

		$effect(() => {
			void this.#virtual.snapshot.revision;
			untrack(() => this.#restoreTreeFocusAfterVirtualRender());
		});

		$effect(() => {
			const selectedFile = options.selectedFile;
			const rows = options.rows;
			if (!selectedFile) {
				this.#lastRevealedSelectionKey = null;
				return;
			}
			const key = gitWorkbenchTreeRowKey({ kind: 'file', path: selectedFile });
			const index = rows.findIndex((row) => row.key === key);
			// Keeps the reveal pending when selection arrives before its row becomes renderable.
			if (index < 0) {
				this.#lastRevealedSelectionKey = null;
				return;
			}
			if (key === this.#lastRevealedSelectionKey) return;
			this.#lastRevealedSelectionKey = key;
			untrack(() => this.#revealSelectedRow(index));
		});
	}

	get snapshot(): VirtualListSnapshot {
		return this.#virtual.snapshot;
	}

	get activeFocusKey(): string | null {
		const rows = this.options.rows;
		if (this.focusedRowKey && rows.some((row) => row.key === this.focusedRowKey)) {
			return this.focusedRowKey;
		}
		const selectedKey = this.options.selectedFile
			? gitWorkbenchTreeRowKey({ kind: 'file', path: this.options.selectedFile })
			: null;
		if (selectedKey && rows.some((row) => row.key === selectedKey)) return selectedKey;
		return rows[0]?.key ?? null;
	}

	get activeRowIndex(): number {
		const activeFocusKey = this.activeFocusKey;
		return this.options.rows.findIndex((row) => row.key === activeFocusKey);
	}

	renderedItems(snapshot: VirtualListSnapshot): readonly VirtualItem[] {
		const items = selectVirtualItems(snapshot, indexesInRange(snapshot.overscanRange));
		if (items.length > 0 || this.options.rows.length === 0) return items;
		return this.options.rows.slice(0, 24).map((row, index) => ({
			index,
			key: row.key,
			start: index * GIT_WORKBENCH_TREE_ROW_HEIGHT,
			size: GIT_WORKBENCH_TREE_ROW_HEIGHT,
			end: (index + 1) * GIT_WORKBENCH_TREE_ROW_HEIGHT,
		}));
	}

	setFocusedRow(key: string): void {
		this.focusedRowKey = key;
	}

	handleTreeKeydown(event: KeyboardEvent): void {
		const activatedFromTreeRoot = event.target === this.options.viewportElement;
		const index = this.activeRowIndex;
		const row = this.options.rows[index];
		if (!row) return;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				this.#focusRowAt(Math.min(this.options.rows.length - 1, index + 1));
				break;
			case 'ArrowUp':
				event.preventDefault();
				this.#focusRowAt(Math.max(0, index - 1));
				break;
			case 'Home':
				event.preventDefault();
				this.#focusRowAt(0);
				break;
			case 'End':
				event.preventDefault();
				this.#focusRowAt(this.options.rows.length - 1);
				break;
			case 'ArrowRight':
				if (row.node.kind !== 'directory') break;
				event.preventDefault();
				if (this.options.collapsedDirs.has(row.node.path)) {
					this.options.onToggleDir(row.node.path);
				} else {
					this.#focusRowAt(index + 1);
				}
				break;
			case 'ArrowLeft':
				event.preventDefault();
				if (row.node.kind === 'directory' && !this.options.collapsedDirs.has(row.node.path)) {
					this.options.onToggleDir(row.node.path);
				} else {
					this.#focusParent(row);
				}
				break;
			case 'Enter':
			case ' ':
				if (!activatedFromTreeRoot) break;
				event.preventDefault();
				this.#activateRow(row);
				break;
		}
	}

	destroy(): void {
		this.#virtual.destroy();
	}

	#currentAnchor(): VirtualMutationAnchor {
		const position = this.#virtual.viewportPosition;
		const item = position
			? this.#virtual.snapshot.positions.itemAtOffset(position.paintedOffset)
			: undefined;
		return item ? { kind: 'item', key: item.key } : { kind: 'none' };
	}

	#revealSelectedRow(index: number): void {
		const item = this.#virtual.snapshot.positions.itemAt(index);
		const position = this.#virtual.viewportPosition;
		const viewportElement = this.options.viewportElement;
		if (!item || !position || !viewportElement) {
			this.#virtual.scrollToIndex(index, { align: 'center' });
			return;
		}
		if (
			item.start < position.paintedOffset ||
			item.end > position.paintedOffset + viewportElement.clientHeight
		) {
			this.#virtual.scrollToIndex(index, { align: 'center' });
		}
	}

	#focusRowAt(index: number): void {
		const row = this.options.rows[index];
		if (!row) return;
		this.focusedRowKey = row.key;
		this.options.viewportElement?.focus({ preventScroll: true });
		const item = this.#virtual.snapshot.positions.itemAt(index);
		const position = this.#virtual.viewportPosition;
		const viewportElement = this.options.viewportElement;
		if (!item || !position || !viewportElement) return;
		if (item.start < position.paintedOffset) {
			this.#virtual.scrollToIndex(index, { align: 'start' });
		} else if (item.end > position.paintedOffset + viewportElement.clientHeight) {
			this.#virtual.scrollToIndex(index, { align: 'end' });
		}
	}

	#restoreTreeFocusAfterVirtualRender(): void {
		const hadTreeFocus = this.#virtualRenderHadTreeFocus;
		this.#virtualRenderHadTreeFocus = false;
		const viewportElement = this.options.viewportElement;
		if (!hadTreeFocus || !viewportElement || !focusWasLostFromDocument()) return;

		const visibleRange = this.#virtual.snapshot.visibleRange;
		if (visibleRange) {
			const activeIndex = this.activeRowIndex;
			const targetIndex = indexWithinRange(
				activeIndex < 0 ? visibleRange.startIndex : activeIndex,
				visibleRange,
			);
			const row = this.options.rows[targetIndex];
			if (row) this.focusedRowKey = row.key;
		}
		viewportElement.focus({ preventScroll: true });
	}

	#focusParent(row: GitWorkbenchTreeRow): void {
		if (!row.parentDirectoryPath) return;
		const parentIndex = this.options.rows.findIndex(
			(candidate) =>
				candidate.node.kind === 'directory' && candidate.node.path === row.parentDirectoryPath,
		);
		if (parentIndex >= 0) this.#focusRowAt(parentIndex);
	}

	#activateRow(row: GitWorkbenchTreeRow): void {
		this.focusedRowKey = row.key;
		if (row.node.kind === 'directory') this.options.onToggleDir(row.node.path);
		else this.options.onSelectFile(row.node.path);
	}
}
