export const SPLIT_PANE_TEXT_SCALE_DEFAULT = 1;
export const SPLIT_PANE_TEXT_SCALE_TWO_PANES = 0.85;
export const SPLIT_PANE_TEXT_SCALE_FOUR_PANES = 0.7;

export function getSplitPaneTextScale(paneCount: number): number {
	if (paneCount >= 4) return SPLIT_PANE_TEXT_SCALE_FOUR_PANES;
	if (paneCount >= 2) return SPLIT_PANE_TEXT_SCALE_TWO_PANES;
	return SPLIT_PANE_TEXT_SCALE_DEFAULT;
}
