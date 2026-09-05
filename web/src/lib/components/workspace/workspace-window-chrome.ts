export const WORKSPACE_WINDOW_TITLEBAR_HEIGHT_PX = 40;
export const WORKSPACE_COMPACT_SWITCHER_HEIGHT_PX = 36;

export function workspaceWindowBodyTopPx(compact: boolean): number {
	return (
		WORKSPACE_WINDOW_TITLEBAR_HEIGHT_PX +
		(compact ? WORKSPACE_COMPACT_SWITCHER_HEIGHT_PX : 0)
	);
}
