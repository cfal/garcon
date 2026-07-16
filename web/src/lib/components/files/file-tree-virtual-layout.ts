export const FILE_TREE_MAX_LAYOUT_HEIGHT = 8_000_000;

export interface FileTreeVirtualLayout {
	rowCount: number;
	rowHeight: number;
	layoutRowHeight: number;
	viewportHeight: number;
	scrollMargin: number;
	bodyHeight: number;
	logicalBodyHeight: number;
	compressed: boolean;
}

interface FileTreeVirtualLayoutOptions {
	rowCount: number;
	rowHeight: number;
	viewportHeight: number;
	scrollMargin: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function createFileTreeVirtualLayout({
	rowCount,
	rowHeight,
	viewportHeight,
	scrollMargin,
}: FileTreeVirtualLayoutOptions): FileTreeVirtualLayout {
	const safeRowCount = Math.max(0, rowCount);
	const safeRowHeight = Math.max(1, rowHeight);
	const layoutRowHeight =
		safeRowCount === 0
			? safeRowHeight
			: Math.min(safeRowHeight, FILE_TREE_MAX_LAYOUT_HEIGHT / safeRowCount);
	return {
		rowCount: safeRowCount,
		rowHeight: safeRowHeight,
		layoutRowHeight,
		viewportHeight: Math.max(1, viewportHeight),
		scrollMargin: Math.max(0, scrollMargin),
		bodyHeight: layoutRowHeight * safeRowCount,
		logicalBodyHeight: safeRowHeight * safeRowCount,
		compressed: layoutRowHeight < safeRowHeight,
	};
}

export function fileTreeMaximumPhysicalScrollOffset(layout: FileTreeVirtualLayout): number {
	return Math.max(0, layout.scrollMargin + layout.bodyHeight - layout.viewportHeight);
}

function maximumLogicalScrollOffset(layout: FileTreeVirtualLayout): number {
	return Math.max(0, layout.scrollMargin + layout.logicalBodyHeight - layout.viewportHeight);
}

export function fileTreePhysicalToLogicalOffset(
	layout: FileTreeVirtualLayout,
	physicalOffset: number,
): number {
	const physicalMaximum = fileTreeMaximumPhysicalScrollOffset(layout);
	if (physicalMaximum === 0) return 0;
	const logicalMaximum = maximumLogicalScrollOffset(layout);
	return (clamp(physicalOffset, 0, physicalMaximum) / physicalMaximum) * logicalMaximum;
}

export function fileTreeLogicalToPhysicalOffset(
	layout: FileTreeVirtualLayout,
	logicalOffset: number,
): number {
	const logicalMaximum = maximumLogicalScrollOffset(layout);
	if (logicalMaximum === 0) return 0;
	const physicalMaximum = fileTreeMaximumPhysicalScrollOffset(layout);
	return (clamp(logicalOffset, 0, logicalMaximum) / logicalMaximum) * physicalMaximum;
}

export function fileTreeLogicalItemStart(layout: FileTreeVirtualLayout, index: number): number {
	return layout.scrollMargin + index * layout.rowHeight;
}

export function fileTreeVirtualRowOffset(
	layout: FileTreeVirtualLayout,
	index: number,
	physicalScrollOffset: number,
	overscan: number,
): number {
	const logicalScrollOffset = fileTreePhysicalToLogicalOffset(layout, physicalScrollOffset);
	const viewportTop = fileTreeLogicalItemStart(layout, index) - logicalScrollOffset;
	const overflowBuffer = layout.rowHeight * Math.max(1, overscan + 1);
	const boundedViewportTop = clamp(
		viewportTop,
		-overflowBuffer,
		layout.viewportHeight + overflowBuffer,
	);
	return boundedViewportTop + physicalScrollOffset - layout.scrollMargin;
}
