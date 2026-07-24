export type VirtualRowKey = string | number | bigint;

export interface VirtualRowMeasurementContext {
	indexFromElement(element: HTMLDivElement): number;
	readonly options: {
		getItemKey(index: number): VirtualRowKey;
	};
	readonly itemSizeCache: ReadonlyMap<VirtualRowKey, number>;
}

type VirtualRowResizeEntry = Pick<ResizeObserverEntry, 'borderBoxSize'>;

export function measureVirtualRow(
	element: HTMLDivElement,
	entry: VirtualRowResizeEntry | undefined,
	instance: VirtualRowMeasurementContext,
): number {
	const box = entry?.borderBoxSize?.[0];
	if (box) return box.blockSize;
	if (entry) return element.getBoundingClientRect().height;
	const index = instance.indexFromElement(element);
	const key = instance.options.getItemKey(index);
	return instance.itemSizeCache.get(key) ?? element.getBoundingClientRect().height;
}
