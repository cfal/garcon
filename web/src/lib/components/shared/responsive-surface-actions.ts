export interface MeasuredSurfaceAction {
	id: string;
	priority: number;
}

export interface ResponsiveSurfaceActionLayoutInput {
	actions: readonly MeasuredSurfaceAction[];
	availableWidth: number;
	widths: ReadonlyMap<string, number>;
	overflowButtonWidth: number;
	gap: number;
}

export function selectVisibleSurfaceActionIds({
	actions,
	availableWidth,
	widths,
	overflowButtonWidth,
	gap,
}: ResponsiveSurfaceActionLayoutInput): ReadonlySet<string> {
	const allActionIds = new Set(actions.map((action) => action.id));
	if (
		availableWidth <= 0 ||
		overflowButtonWidth <= 0 ||
		actions.some((action) => !widths.has(action.id))
	) {
		return allActionIds;
	}

	if (layoutWidth(actions, widths, gap, 0) <= availableWidth) return allActionIds;

	const visibleActionIds = new Set<string>();
	const priorityOrder = actions
		.map((action, index) => ({ action, index }))
		.sort((left, right) =>
			left.action.priority === right.action.priority
				? left.index - right.index
				: left.action.priority - right.action.priority,
		);

	for (const { action } of priorityOrder) {
		const candidateIds = new Set(visibleActionIds);
		candidateIds.add(action.id);
		const candidates = actions.filter((candidate) => candidateIds.has(candidate.id));
		if (layoutWidth(candidates, widths, gap, overflowButtonWidth) <= availableWidth) {
			visibleActionIds.add(action.id);
		}
	}

	return visibleActionIds;
}

function layoutWidth(
	actions: readonly MeasuredSurfaceAction[],
	widths: ReadonlyMap<string, number>,
	gap: number,
	overflowButtonWidth: number,
): number {
	const actionWidth = actions.reduce((total, action) => total + (widths.get(action.id) ?? 0), 0);
	const itemCount = actions.length + (overflowButtonWidth > 0 ? 1 : 0);
	return actionWidth + overflowButtonWidth + Math.max(0, itemCount - 1) * gap;
}
