export interface FileTreeBreadcrumbLayout {
	visibleIndices: readonly number[];
	overflowIndices: readonly number[];
}

export function selectFileTreeBreadcrumbLayout(args: {
	count: number;
	availableWidth: number;
	segmentWidths: ReadonlyMap<number, number>;
	separatorWidth: number;
	overflowWidth: number;
	gap: number;
}): FileTreeBreadcrumbLayout {
	const { count, availableWidth, segmentWidths, separatorWidth, overflowWidth, gap } = args;
	const all = Array.from({ length: count }, (_, index) => index);
	if (count <= 2 || availableWidth <= 0 || all.some((index) => !segmentWidths.has(index))) {
		return { visibleIndices: all, overflowIndices: [] };
	}

	const widthOf = (indices: readonly number[], hasOverflow: boolean): number => {
		const itemWidths = indices.reduce((total, index) => total + (segmentWidths.get(index) ?? 0), 0);
		const controlCount = indices.length + (hasOverflow ? 1 : 0);
		return (
			itemWidths +
			(hasOverflow ? overflowWidth : 0) +
			Math.max(0, controlCount - 1) * (separatorWidth + gap)
		);
	};

	if (widthOf(all, false) <= availableWidth) {
		return { visibleIndices: all, overflowIndices: [] };
	}

	const visible = [0, count - 1];
	for (let index = count - 2; index > 0; index -= 1) {
		const candidate = [0, index, ...visible.slice(1)];
		if (widthOf(candidate, index > 1) > availableWidth) break;
		visible.splice(1, 0, index);
	}
	const visibleSet = new Set(visible);
	return {
		visibleIndices: visible,
		overflowIndices: all.filter((index) => !visibleSet.has(index)),
	};
}
