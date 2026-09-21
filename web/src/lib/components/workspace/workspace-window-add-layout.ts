const WORKSPACE_WINDOW_ADD_CONTROL_WIDTH_PX = 28;
const WORKSPACE_WINDOW_ADD_CONTROL_GAP_PX = 2;

export interface WorkspaceWindowTabMeasure {
	readonly naturalWidth: number;
	readonly viewportWidth: number;
}

export interface WorkspaceWindowInlineAddActionInput {
	measure: WorkspaceWindowTabMeasure | null;
	eligibleCount: number;
	currentInlineCount: number;
	controlWidthPx?: number;
}

export function resolveWorkspaceWindowInlineAddActionCount({
	measure,
	eligibleCount,
	currentInlineCount,
	controlWidthPx = WORKSPACE_WINDOW_ADD_CONTROL_WIDTH_PX,
}: WorkspaceWindowInlineAddActionInput): number {
	if (!measure || eligibleCount <= 0) return 0;

	const renderedInlineCount = Math.min(eligibleCount, Math.max(0, currentInlineCount));
	if (renderedInlineCount > 0 && measure.viewportWidth <= 0) return 0;
	const currentControlsWidth = addControlsWidth(
		renderedInlineCount,
		renderedInlineCount < eligibleCount,
		controlWidthPx,
	);
	const availableWidth = measure.viewportWidth + currentControlsWidth;

	for (let candidate = eligibleCount; candidate >= 0; candidate -= 1) {
		const showMenu = candidate < eligibleCount;
		const candidateControlsWidth = addControlsWidth(candidate, showMenu, controlWidthPx);
		if (measure.naturalWidth + candidateControlsWidth <= availableWidth) {
			return candidate;
		}
	}

	return 0;
}

function addControlsWidth(
	inlineCount: number,
	showMenu: boolean,
	controlWidthPx: number,
): number {
	const controlCount = inlineCount + (showMenu ? 1 : 0);
	return (
		controlCount * controlWidthPx +
		Math.max(0, controlCount - 1) * WORKSPACE_WINDOW_ADD_CONTROL_GAP_PX
	);
}
