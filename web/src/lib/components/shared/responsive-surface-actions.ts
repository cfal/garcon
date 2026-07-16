export interface MeasuredSurfaceAction {
	id: string;
	priority: number;
}

export interface ResponsiveSurfaceActionLayoutInput {
	actions: readonly MeasuredSurfaceAction[];
	availableWidth: number;
	widths: ReadonlyMap<string, number>;
	menuButtonWidth: number;
	menuVisibility: 'overflow' | 'persistent';
	gap: number;
}

export function selectVisibleSurfaceActionIds({
	actions,
	availableWidth,
	widths,
	menuButtonWidth,
	menuVisibility,
	gap,
}: ResponsiveSurfaceActionLayoutInput): ReadonlySet<string> {
	const allActionIds = new Set(actions.map((action) => action.id));
	if (
		availableWidth <= 0 ||
		menuButtonWidth <= 0 ||
		actions.some((action) => !widths.has(action.id))
	) {
		return allActionIds;
	}

	const fullMenuWidth = menuVisibility === 'persistent' ? menuButtonWidth : 0;
	if (layoutWidth(actions, widths, gap, fullMenuWidth) <= availableWidth) return allActionIds;

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
		if (layoutWidth(candidates, widths, gap, menuButtonWidth) <= availableWidth) {
			visibleActionIds.add(action.id);
		}
	}

	return visibleActionIds;
}

function layoutWidth(
	actions: readonly MeasuredSurfaceAction[],
	widths: ReadonlyMap<string, number>,
	gap: number,
	menuButtonWidth: number,
): number {
	const actionWidth = actions.reduce((total, action) => total + (widths.get(action.id) ?? 0), 0);
	const itemCount = actions.length + (menuButtonWidth > 0 ? 1 : 0);
	return actionWidth + menuButtonWidth + Math.max(0, itemCount - 1) * gap;
}
