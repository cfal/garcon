export interface TaskbarLayoutInput {
	order: readonly string[];
	activeId: string | null;
	pinnedIds: readonly string[];
	availableWidth: number;
	widths: ReadonlyMap<string, number>;
	gap: number;
}

export function selectVisibleTaskbarSurfaceIds(input: TaskbarLayoutInput): readonly string[] {
	const { order, activeId, pinnedIds, availableWidth, widths, gap } = input;
	if (order.some((surfaceId) => !widths.has(surfaceId))) return order;
	const total = order.reduce(
		(sum, surfaceId, index) => sum + (widths.get(surfaceId) ?? 0) + (index > 0 ? gap : 0),
		0,
	);
	if (total <= availableWidth) return order;

	const selected = new Set<string>();
	for (const surfaceId of pinnedIds) {
		if (order.includes(surfaceId)) selected.add(surfaceId);
	}
	if (activeId && order.includes(activeId)) selected.add(activeId);
	let used = [...selected].reduce(
		(sum, surfaceId, index) => sum + (widths.get(surfaceId) ?? 0) + (index > 0 ? gap : 0),
		0,
	);
	for (const surfaceId of order) {
		if (selected.has(surfaceId)) continue;
		const width = widths.get(surfaceId) ?? 0;
		const nextGap = selected.size > 0 ? gap : 0;
		if (used + nextGap + width > availableWidth) continue;
		selected.add(surfaceId);
		used += nextGap + width;
	}
	return order.filter((surfaceId) => selected.has(surfaceId));
}
