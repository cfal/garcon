type VirtualRowResizeEntry = Pick<ResizeObserverEntry, 'borderBoxSize'>;

export function measureVirtualRow(
	element: HTMLElement,
	entry: VirtualRowResizeEntry | undefined,
): number {
	const box = entry?.borderBoxSize?.[0];
	if (box) return box.blockSize;
	return element.getBoundingClientRect().height;
}
