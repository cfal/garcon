export interface ViewportAnchor {
	rowId: string;
	viewportOffset: number;
	previousScrollHeight: number;
	previousScrollTop: number;
	element?: HTMLElement;
}

const ANCHOR_SELECTOR = '[data-chat-anchor-id]';

export function captureViewportAnchor(
	scroller: HTMLElement,
	content: HTMLElement,
	preferredAnchor?: ViewportAnchor | null,
): ViewportAnchor | null {
	const viewportTop = scroller.getBoundingClientRect().top;
	const viewportBottom = viewportTop + scroller.clientHeight;
	const preferred = preferredAnchor?.element;
	const preferredRect = preferred?.getBoundingClientRect();
	const row =
		preferred &&
		preferredRect &&
		content.contains(preferred) &&
		preferred.dataset.chatAnchorId === preferredAnchor.rowId &&
		preferredRect.bottom > viewportTop &&
		preferredRect.top < viewportBottom
			? preferred
			: Array.from(content.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)).find(
					(candidate) => candidate.getBoundingClientRect().bottom > viewportTop,
				);
	const rowId = row?.dataset.chatAnchorId;
	if (!row || !rowId) return null;

	return {
		rowId,
		viewportOffset: row.getBoundingClientRect().top - viewportTop,
		previousScrollHeight: scroller.scrollHeight,
		previousScrollTop: scroller.scrollTop,
		element: row,
	};
}

export function restoreViewportAnchor(
	anchor: ViewportAnchor,
	scroller: HTMLElement,
	content: HTMLElement,
): boolean {
	const anchoredElement = anchor.element;
	const row =
		anchoredElement &&
		content.contains(anchoredElement) &&
		anchoredElement.dataset.chatAnchorId === anchor.rowId
			? anchoredElement
			: Array.from(content.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)).find(
					(candidate) => candidate.dataset.chatAnchorId === anchor.rowId,
				);
	if (!row) return false;

	const viewportTop = scroller.getBoundingClientRect().top;
	const nextOffset = row.getBoundingClientRect().top - viewportTop;
	scroller.scrollTop += nextOffset - anchor.viewportOffset;
	return true;
}

export function restoreEarlierHeightFallback(anchor: ViewportAnchor, scroller: HTMLElement): void {
	scroller.scrollTop =
		anchor.previousScrollTop + (scroller.scrollHeight - anchor.previousScrollHeight);
}
