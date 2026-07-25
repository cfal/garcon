export interface TaskbarLayoutInput {
	order: readonly string[];
	activeId: string | null;
	pinnedIds: readonly string[];
	availableWidth: number;
	widths: ReadonlyMap<string, number>;
	gap: number;
}

export interface CenteredTaskbarCapacityInput {
	containerWidth: number;
	startWidth: number;
	endWidth: number;
	regionGap: number;
	railChromeWidth: number;
}

export interface CenteredTaskbarCapacity {
	railWidth: number;
	contentWidth: number;
}

export function resolveCenteredTaskbarCapacity({
	containerWidth,
	startWidth,
	endWidth,
	regionGap,
	railChromeWidth,
}: CenteredTaskbarCapacityInput): CenteredTaskbarCapacity {
	const sideReserve = Math.max(startWidth, endWidth);
	const railWidth = Math.max(0, containerWidth - 2 * (sideReserve + regionGap));

	return {
		railWidth,
		contentWidth: Math.max(0, railWidth - railChromeWidth),
	};
}

export function selectVisibleTaskbarSurfaceIds(input: TaskbarLayoutInput): readonly string[] {
	const { order, activeId, pinnedIds, availableWidth, widths, gap } = input;
	if (order.some((surfaceId) => !widths.has(surfaceId))) return order;
	const total = order.reduce(
		(sum, surfaceId, index) => sum + (widths.get(surfaceId) ?? 0) + (index > 0 ? gap : 0),
		0,
	);
	if (total <= availableWidth) return order;
	if (availableWidth <= 0) return [];

	const selected = new Set<string>();
	let used = 0;

	if (activeId && order.includes(activeId)) {
		selected.add(activeId);
		used = Math.min(widths.get(activeId) ?? 0, availableWidth);
	}

	for (const surfaceId of [...pinnedIds, ...order]) {
		if (selected.has(surfaceId)) continue;
		if (!order.includes(surfaceId)) continue;
		const width = widths.get(surfaceId) ?? 0;
		const nextGap = selected.size > 0 ? gap : 0;
		if (used + nextGap + width > availableWidth) continue;
		selected.add(surfaceId);
		used += nextGap + width;
	}
	return order.filter((surfaceId) => selected.has(surfaceId));
}
