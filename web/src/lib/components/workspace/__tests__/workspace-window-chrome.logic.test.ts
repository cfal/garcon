import { describe, expect, it } from 'vitest';
import {
	DEFAULT_WORKSPACE_WINDOW_TITLEBAR_METRICS,
	workspaceWindowTitlebarMetrics,
} from '../workspace-window-chrome.js';

describe('workspaceWindowTitlebarMetrics', () => {
	it.each([
		[-2, 38, 26, 13, 11],
		[-1, 39, 27, 13, 12],
		[0, 40, 28, 14, 12],
		[1, 41, 29, 14, 12],
		[2, 42, 30, 15, 13],
		[3, 43, 31, 15, 13],
		[4, 44, 32, 16, 13],
		[5, 45, 33, 16, 14],
		[6, 46, 34, 17, 14],
	] as const)(
		'maps a %ipx adjustment to coordinated chrome metrics',
		(delta, heightPx, controlSizePx, iconSizePx, labelFontSizePx) => {
			expect(workspaceWindowTitlebarMetrics(delta)).toEqual({
				heightPx,
				controlSizePx,
				compactControlSizePx: controlSizePx - 4,
				iconSizePx,
				labelFontSizePx,
				tabClosePaddingInlineEndPx: controlSizePx + 4,
				inlineCloseReservedWidthPx: controlSizePx - 4,
			});
		},
	);

	it('falls back to the default metrics outside the persisted setting contract', () => {
		expect(workspaceWindowTitlebarMetrics(7)).toBe(DEFAULT_WORKSPACE_WINDOW_TITLEBAR_METRICS);
	});
});
