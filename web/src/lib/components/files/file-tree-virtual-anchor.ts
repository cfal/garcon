import type { VirtualItem } from '@tanstack/svelte-virtual';
import type {
	FileTreeRenderModel,
	FileTreeRenderRow,
} from '$lib/files/tree/file-tree-render-rows.js';

export interface FileTreeVirtualAnchor {
	key: string;
	previousIndex: number;
	offsetFromContentViewport: number;
}

export function captureFileTreeVirtualAnchor(
	rows: readonly FileTreeRenderRow[],
	virtualItems: readonly VirtualItem[],
	scrollOffset: number,
): FileTreeVirtualAnchor | null {
	const firstVisible = virtualItems.find((item) => item.end > scrollOffset);
	const row = firstVisible ? rows[firstVisible.index] : undefined;
	if (!firstVisible || !row) return null;
	return {
		key: row.key,
		previousIndex: firstVisible.index,
		offsetFromContentViewport: firstVisible.start - scrollOffset,
	};
}

export function resolveFileTreeAnchorIndex(
	anchor: FileTreeVirtualAnchor,
	previousRows: readonly FileTreeRenderRow[],
	nextModel: FileTreeRenderModel,
): number | null {
	const exact = nextModel.renderIndexByKey.get(anchor.key);
	if (exact !== undefined) return exact;
	for (
		let index = Math.min(anchor.previousIndex - 1, previousRows.length - 1);
		index >= 0;
		index -= 1
	) {
		const key = previousRows[index]?.key;
		const survivingIndex = key ? nextModel.renderIndexByKey.get(key) : undefined;
		if (survivingIndex !== undefined) return survivingIndex;
	}
	return nextModel.rows.length > 0 ? 0 : null;
}
