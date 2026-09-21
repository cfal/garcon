export const WORKSPACE_WINDOW_TITLEBAR_HEIGHT_PX = 40;
const WORKSPACE_WINDOW_INLINE_CLOSE_SIZE_OFFSET_PX = 4;
const WORKSPACE_WINDOW_TAB_PADDING_INLINE_PX = 8;

export interface WorkspaceWindowTitlebarMetrics {
	readonly heightPx: number;
	readonly controlSizePx: number;
	readonly compactControlSizePx: number;
	readonly iconSizePx: number;
	readonly labelFontSizePx: number;
	readonly tabClosePaddingInlineEndPx: number;
	readonly inlineCloseReservedWidthPx: number;
}

const WORKSPACE_WINDOW_TITLEBAR_METRICS_BY_DELTA: Readonly<
	Record<number, WorkspaceWindowTitlebarMetrics>
> = {
	[-2]: metrics(38, 26, 13, 11),
	[-1]: metrics(39, 27, 13, 12),
	0: metrics(WORKSPACE_WINDOW_TITLEBAR_HEIGHT_PX, 28, 14, 12),
	1: metrics(41, 29, 14, 12),
	2: metrics(42, 30, 15, 13),
	3: metrics(43, 31, 15, 13),
	4: metrics(44, 32, 16, 13),
	5: metrics(45, 33, 16, 14),
	6: metrics(46, 34, 17, 14),
};

export const DEFAULT_WORKSPACE_WINDOW_TITLEBAR_METRICS =
	WORKSPACE_WINDOW_TITLEBAR_METRICS_BY_DELTA[0];

export function workspaceWindowTitlebarMetrics(
	heightDeltaPx: number,
): WorkspaceWindowTitlebarMetrics {
	return (
		WORKSPACE_WINDOW_TITLEBAR_METRICS_BY_DELTA[heightDeltaPx] ??
		DEFAULT_WORKSPACE_WINDOW_TITLEBAR_METRICS
	);
}

function metrics(
	heightPx: number,
	controlSizePx: number,
	iconSizePx: number,
	labelFontSizePx: number,
): WorkspaceWindowTitlebarMetrics {
	const compactControlSizePx = controlSizePx - WORKSPACE_WINDOW_INLINE_CLOSE_SIZE_OFFSET_PX;
	return {
		heightPx,
		controlSizePx,
		compactControlSizePx,
		iconSizePx,
		labelFontSizePx,
		tabClosePaddingInlineEndPx: compactControlSizePx + WORKSPACE_WINDOW_TAB_PADDING_INLINE_PX,
		inlineCloseReservedWidthPx: compactControlSizePx,
	};
}
