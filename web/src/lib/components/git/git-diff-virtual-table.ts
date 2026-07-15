import { observeElementRect, type Rect, type Virtualizer } from '@tanstack/svelte-virtual';
import type { GitReviewCommentDraft } from '$lib/api/git.js';

export const DIFF_TABLE_FALLBACK_VIEWPORT_HEIGHT = 640;
export const DIFF_TABLE_OVERSCAN = 12;

const commentRowEstimate = 40;
const composerRowEstimate = 156;
const hunkPaddingEstimate = 8;

export interface DiffVirtualRow {
	key: string;
	isHunkHeader: boolean;
	comments: GitReviewCommentDraft[];
	showComposer: boolean;
}

export function estimateDiffVirtualRowSize(
	row: DiffVirtualRow | undefined,
	rowLineHeight: number,
): number {
	if (!row) return rowLineHeight;
	let estimate = rowLineHeight;
	if (row.isHunkHeader) estimate += hunkPaddingEstimate;
	if (row.comments.length > 0) estimate += row.comments.length * commentRowEstimate;
	if (row.showComposer) estimate += composerRowEstimate;
	return estimate;
}

export function measureDiffVirtualRowElement<T extends DiffVirtualRow>(
	element: HTMLTableSectionElement,
	rows: T[],
	rowLineHeight: number,
): number {
	const index = Number(element.dataset.index ?? -1);
	const measuredHeight = element.getBoundingClientRect().height;
	return measuredHeight > 0
		? measuredHeight
		: estimateDiffVirtualRowSize(rows[index], rowLineHeight);
}

export function observeDiffTableElementRect<TScrollElement extends Element>(
	instance: Virtualizer<TScrollElement, HTMLTableSectionElement>,
	callback: (rect: Rect) => void,
) {
	return observeElementRect(instance, (rect) => {
		callback(rect.height > 0 ? rect : { ...rect, height: DIFF_TABLE_FALLBACK_VIEWPORT_HEIGHT });
	});
}
