interface FittingTagPrefixInput {
	readonly availableWidth: number;
	readonly agentWidth: number;
	readonly tagWidths: readonly number[];
	readonly totalTagCount: number;
	readonly overflowWidths: ReadonlyMap<number, number>;
	readonly gap: number;
	readonly maxRows: number;
}

type ResizeListener = (entry: ResizeObserverEntry) => void;

const resizeListeners = new Map<Element, Set<ResizeListener>>();
let sharedResizeObserver: ResizeObserver | null = null;

export function observeChatAgentTagsSize(element: Element, listener: ResizeListener): () => void {
	if (typeof ResizeObserver === 'undefined') return () => {};
	let listeners = resizeListeners.get(element);
	if (!listeners) {
		listeners = new Set();
		resizeListeners.set(element, listeners);
		sharedResizeObserver ??= new ResizeObserver((entries) => {
			for (const entry of entries) {
				for (const callback of resizeListeners.get(entry.target) ?? []) callback(entry);
			}
		});
		sharedResizeObserver.observe(element);
	}
	listeners.add(listener);
	return () => {
		const current = resizeListeners.get(element);
		current?.delete(listener);
		if (current?.size === 0) {
			resizeListeners.delete(element);
			sharedResizeObserver?.unobserve(element);
		}
		if (resizeListeners.size === 0) {
			sharedResizeObserver?.disconnect();
			sharedResizeObserver = null;
		}
	};
}

function fitsRows(widths: readonly number[], availableWidth: number, gap: number, maxRows: number): boolean {
	let rows = 1;
	let rowWidth = 0;
	for (const measuredWidth of widths) {
		const width = Math.min(Math.max(0, measuredWidth), availableWidth);
		if (rowWidth === 0 || rowWidth + gap + width <= availableWidth) {
			rowWidth += (rowWidth === 0 ? 0 : gap) + width;
			continue;
		}
		rows += 1;
		if (rows > maxRows) return false;
		rowWidth = width;
	}
	return true;
}

export function selectFittingTagPrefix(input: FittingTagPrefixInput): number {
	if (input.availableWidth <= 0 || input.maxRows < 1) return 0;
	const maximum = Math.min(input.tagWidths.length, Math.max(0, input.totalTagCount));
	for (let count = maximum; count >= 0; count -= 1) {
		const hiddenCount = input.totalTagCount - count;
		const widths = [input.agentWidth, ...input.tagWidths.slice(0, count)];
		if (hiddenCount > 0) {
			const overflowWidth = input.overflowWidths.get(hiddenCount);
			if (overflowWidth === undefined) continue;
			widths.push(overflowWidth);
		}
		if (fitsRows(widths, input.availableWidth, input.gap, input.maxRows)) return count;
	}
	return 0;
}
